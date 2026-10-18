import { assert } from "chai";
import { getPref } from "../src/utils/prefs";
import { listener, plugin, waitFor } from "./helpers";

describe("read from here", function () {
  let reader: any;
  let container: HTMLElement;

  before(async function () {
    if (!getPref("modelDir")) this.skip();
    this.timeout(60 * 1000);
    const dir = Zotero.Prefs.get(
      "extensions.kokororeader-test.fixtures",
      true,
    ) as string;
    const item = await Zotero.Attachments.importFromFile({
      file: PathUtils.join(dir, "sample-paper.pdf"),
    });
    reader = await Zotero.Reader.open(item.id);
    await reader._initPromise;
    const doc = Zotero.getMainWindow().document;
    container = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLElement;
    doc.documentElement!.append(container);
  });

  after(function () {
    plugin()?.api.player.stop();
    container?.remove();
    if (reader) Zotero.getMainWindow().Zotero_Tabs.close(reader.tabID);
  });

  async function readFromMenu(params: object): Promise<string[]> {
    const { player } = plugin().api;
    const items: any[] = [];
    listener("createViewContextMenu")({
      reader,
      params,
      append: (...i: any[]) => items.push(...i),
    });
    items.at(-1).onCommand();
    await waitFor(() => player.state === "playing");
    const sentences = [...player.sentences];
    player.stop();
    return sentences;
  }

  it("reads from the right-clicked sentence to the References heading", async function () {
    this.timeout(2 * 60 * 1000);
    const sentences = await readFromMenu({
      position: { pageIndex: 1, rects: [[72, 678, 200, 690]] },
    });
    assert.equal(
      sentences.join(" "),
      "The second page continues the method section here. Our results show that listening helps with long papers. 3 Conclusion. Reading aloud makes papers easier to review on the go.",
    );
  });

  it("starts at the current page without a position", async function () {
    this.timeout(60 * 1000);
    const sentences = await readFromMenu({});
    assert.equal(sentences[0], "1 Introduction.");
  });

  it("continues across the page break from the selection popup, skipping headers and page numbers", async function () {
    this.timeout(60 * 1000);
    const { player } = plugin().api;
    listener("renderTextSelectionPopup")({
      reader,
      doc: Zotero.getMainWindow().document,
      params: {
        annotation: {
          text: "Small models now run on a laptop without a server.",
          position: { pageIndex: 0, rects: [[72, 637.5, 344, 651]] },
        },
      },
      append: (...nodes: Node[]) => container.replaceChildren(...nodes),
    });
    const [, fromHere] = Array.from(container.querySelectorAll("button"));
    fromHere.click();
    await waitFor(() => player.state === "playing");
    const sentences: string[] = [...player.sentences];
    player.stop();
    const text = sentences.join(" ");
    assert.match(text, /^Small models now run on a laptop without a server\. /);
    assert.include(text, "The second page continues the method section here.");
    for (const s of sentences) {
      assert.notInclude(s, "Sample Paper for Kokoro");
      assert.notMatch(s, /^\d+\.?$/);
      assert.notInclude(s, "A. Author");
    }
  });

  it("preloads the model when a reader tab is selected", async function () {
    this.timeout(60 * 1000);
    const { engine } = plugin().api;
    engine.destroy();
    assert.equal(engine.size, 0);
    const tabs = Zotero.getMainWindow().Zotero_Tabs;
    tabs.select("zotero-pane");
    tabs.select(reader.tabID);
    await waitFor(() => engine.loaded, 60000);
  });

  async function secondsUntilPlaying(text: string): Promise<number> {
    const { player } = plugin().api;
    const started = Date.now();
    player.readText(text);
    await waitFor(() => player.state === "playing");
    return (Date.now() - started) / 1000;
  }

  const SECOND_TEXT =
    "Secure multiparty computation lets several parties compute a function of their private inputs without revealing them. Practical protocols split the work into an input independent preprocessing phase and a fast online phase, and most of the cost lies in generating correlated randomness such as multiplication triples.";

  const LONG_TEXT =
    "Large language models have shown remarkable abilities, yet their reasoning remains brittle under distribution shift. We study why this happens and propose a fix that works across several benchmarks, models and languages. Our analysis covers training data, architecture and decoding.";

  it("starts speaking quickly once the model is preloaded", async function () {
    this.timeout(60 * 1000);
    const seconds = await secondsUntilPlaying(LONG_TEXT);
    plugin().api.player.stop();
    assert.isBelow(seconds, 3, `first audio after ${seconds.toFixed(2)}s`);
  });

  it("restarts quickly after stopping in the middle of a read", async function () {
    this.timeout(60 * 1000);
    const { player, engine } = plugin().api;
    await waitFor(() => engine.loaded, 30000);
    await secondsUntilPlaying(LONG_TEXT);
    player.stop(); // workers are mid-synthesis here
    const seconds = await secondsUntilPlaying(
      "Another selection is read right away. It keeps going.",
    );
    player.stop();
    assert.isBelow(seconds, 3, `restart took ${seconds.toFixed(2)}s`);
  });

  it("switches to another passage quickly and without long pauses", async function () {
    this.timeout(2 * 60 * 1000);
    const { player, engine } = plugin().api;
    await waitFor(() => engine.loaded, 30000);
    await secondsUntilPlaying(`${LONG_TEXT} ${LONG_TEXT}`);
    await Zotero.Promise.delay(4000); // reading, with synthesis queued ahead
    await secondsUntilPlaying(`${SECOND_TEXT} ${SECOND_TEXT}`);
    await waitFor(() => player.state === "idle" || player.index >= 8, 90000);
    const { firstAudioMs, gapsMs } = player.stats;
    player.stop();
    const totalGap = gapsMs.reduce((a: number, b: number) => a + b, 0);
    const summary = `first audio ${firstAudioMs} ms, pauses ${gapsMs.join("/")} ms`;
    Zotero.debug(`[kokoro test] switch: ${summary}`);
    assert.isBelow(firstAudioMs, 2500, summary);
    assert.isBelow(totalGap, 1500, summary);
  });
});
