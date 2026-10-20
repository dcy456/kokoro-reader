import { assert } from "chai";
import { engine, isModelDownloaded } from "../src/modules/engine";
import { getPref } from "../src/utils/prefs";

/** The scaffold reporter drops thrown errors' messages; surface them. */
async function report<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    assert.fail(`${e}\n${e?.stack ?? ""}`);
  }
}

describe("kokoro engine", function () {
  before(function () {
    // Needs a ~90 MB model download; only runs when a persistent model dir is
    // configured (see zotero-plugin.config.ts test.prefs).
    if (!getPref("modelDir")) this.skip();
  });

  // The plugin has its own engine instance (see ui.test.ts); free this one.
  after(function () {
    engine.destroy();
  });

  it("downloads, loads and synthesizes a sentence", async function () {
    this.timeout(15 * 60 * 1000);
    await report(() => engine.ensureReady());
    assert.isTrue(await isModelDownloaded());
    const audio = await report(() =>
      engine.synth("Attention is all you need.", "af_heart", 1),
    );
    assert.equal(audio.sampleRate, 24000);
    const seconds = audio.pcm.length / audio.sampleRate;
    assert.isAbove(seconds, 0.5);
    assert.isBelow(seconds, 6);
    const peak = audio.pcm.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    assert.isAbove(peak, 0.01, "audio should not be silent");
    Zotero.debug(
      `[kokoro test] ${seconds.toFixed(2)}s audio, ${engine.lastSpeedFactor.toFixed(2)}x real time`,
    );
  });

  it("synthesizes faster than real time with the worker pool", async function () {
    this.timeout(2 * 60 * 1000);
    const sentences = [
      "Transformers rely entirely on self attention to compute representations.",
      "We evaluate our method on three standard benchmarks.",
      "The results show that the proposed model outperforms strong baselines.",
      "Finally, we analyze the attention patterns learned by each layer.",
    ];
    const started = Date.now();
    const audios = await report(() =>
      Promise.all(sentences.map((s) => engine.synth(s, "af_heart", 1))),
    );
    const wall = (Date.now() - started) / 1000;
    const seconds = audios.reduce((n, a) => n + a.pcm.length / a.sampleRate, 0);
    assert.isAbove(
      seconds / wall,
      1,
      `throughput ${(seconds / wall).toFixed(2)}x`,
    );
  });

  it("cancels queued requests on clear", async function () {
    this.timeout(60 * 1000);
    const pending = engine.synth(
      "This request will be cancelled.",
      "af_heart",
      1,
    );
    engine.clear();
    try {
      await pending;
      assert.fail("expected cancellation");
    } catch (e: any) {
      assert.equal(e.message, "cancelled");
    }
    // The engine still works afterwards.
    const audio = await report(() =>
      engine.synth("Still working.", "af_heart", 1),
    );
    assert.isAbove(audio.pcm.length, 0);
  });

  it("never returns silent (NaN) audio for inputs that overflow fp16", async function () {
    this.timeout(5 * 60 * 1000);
    // Each of these made the fp16 model return an all-NaN waveform.
    const texts = [
      "Theorem 1.",
      "Lemma 2.",
      "Definition 3.",
      "Let n greater than or equal to 3.",
      "Using zero-knowledge proofs,",
      "To obtain active security over fields,",
      "where C is the circuit to be computed.",
    ];
    const before = engine.rescued;
    for (const text of texts) {
      const audio = await report(() => engine.synth(text, "af_heart", 1));
      assert.isTrue(
        audio.pcm.every((x) => Number.isFinite(x)),
        `NaN audio for ${text}`,
      );
      const peak = audio.pcm.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
      assert.isAbove(peak, 0.05, `silent audio for ${text}`);
    }
    // Guards against the test passing because the bug went away by itself.
    if (getPref("dtype") === "fp16") assert.isAbove(engine.rescued, before);
  });
});
