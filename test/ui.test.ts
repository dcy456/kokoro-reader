import { assert } from "chai";
import { config } from "../package.json";
import { getPref, setPref } from "../src/utils/prefs";
import { listener, plugin, waitFor } from "./helpers";

const TEXT =
  "Attention mechanisms [3] let models focus on relevant inputs. They are widely used (Bahdanau et al., 2015).";

describe("reader UI", function () {
  let win: _ZoteroTypes.MainWindow;
  let doc: Document;
  let container: HTMLElement;

  before(function () {
    if (!getPref("modelDir")) this.skip();
    win = Zotero.getMainWindow();
    doc = win.document;
    container = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLElement;
    doc.documentElement!.append(container);
  });

  after(function () {
    plugin()?.api.player.stop();
    container?.remove();
  });

  function showPopup(text = TEXT): HTMLButtonElement {
    container.replaceChildren();
    listener("renderTextSelectionPopup")({
      reader: null,
      doc,
      params: { annotation: { text } },
      append: (...nodes: Node[]) => container.append(...nodes),
    });
    const button = container.querySelector("button");
    assert.exists(button, "popup button added");
    return button as HTMLButtonElement;
  }

  const bar = () => doc.getElementById(`${config.addonRef}-bar`) as HTMLElement;

  it("adds a read-aloud button to the selection popup", function () {
    const button = showPopup();
    assert.include(button.textContent, "Kokoro");
  });

  it("plays the cleaned selection and shows the bar", async function () {
    this.timeout(5 * 60 * 1000);
    const { player } = plugin().api;
    showPopup().click();
    await waitFor(() => player.state === "playing");
    assert.isFalse(bar().hidden, "bar visible");
    // Citations are dropped; the first sentence is split to start sooner.
    assert.equal(
      player.sentences.join(" "),
      "Attention mechanisms let models focus on relevant inputs. They are widely used.",
    );
    assert.equal(
      bar().querySelector(`.${config.addonRef}-text`)!.textContent,
      player.sentences[0],
    );
  });

  it("pauses, resumes and stops from the bar", async function () {
    const { player } = plugin().api;
    const [toggle, stop] = Array.from(
      bar().querySelectorAll("button"),
    ) as HTMLButtonElement[];
    toggle.click();
    assert.equal(player.state, "paused");
    toggle.click();
    assert.equal(player.state, "playing");
    stop.click();
    assert.equal(player.state, "idle");
    assert.isTrue(bar().hidden, "bar hidden after stop");
  });

  it("keeps playing when speed changes mid-sentence", async function () {
    this.timeout(60 * 1000);
    const { player } = plugin().api;
    const before = getPref("speed");
    showPopup().click();
    await waitFor(() => player.state === "playing");
    const speed = bar().querySelector("select") as HTMLSelectElement;
    speed.value = "1.5";
    speed.dispatchEvent(new win.Event("change"));
    assert.equal(getPref("speed"), "1.5");
    // The second sentence is re-synthesized and still plays.
    await waitFor(
      () =>
        bar().querySelector(`.${config.addonRef}-text`)!.textContent ===
        "They are widely used.",
      30000,
    );
    assert.equal(player.state, "playing");
    player.stop();
    setPref("speed", before);
  });

  it("toggles reading with the keyboard shortcut", async function () {
    this.timeout(60 * 1000);
    const { player } = plugin().api;
    showPopup(); // an active selection
    const press = () =>
      doc.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          code: "KeyR",
          key: "‰", // what Option+Shift+R types on macOS
          altKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    press();
    await waitFor(() => player.state !== "idle", 5000);
    press();
    assert.equal(player.state, "idle");
  });

  it("offers read-selection only while text is selected", function () {
    const labels = () => {
      const items: any[] = [];
      listener("createViewContextMenu")({
        reader: null,
        params: {},
        append: (...i: any[]) => items.push(...i),
      });
      return items.map((i) => i.label);
    };
    showPopup();
    assert.lengthOf(labels(), 2);
    container.replaceChildren(); // selection cleared, popup removed
    assert.lengthOf(labels(), 1);
  });
});
