/**
 * Plays a list of sentences. Upcoming sentences are synthesized ahead of
 * playback, enough to keep every worker in the engine's pool busy, so
 * playback runs without gaps once the first sentence is ready.
 */
import { engine, type Audio } from "./engine";
import { prepareSpeech } from "./text";
import { getPref } from "../utils/prefs";
import { bar } from "./bar";
import { getString } from "../utils/locale";
import { pauseAfter, trimSilence } from "./audio";

export type PlayerState = "idle" | "loading" | "playing" | "paused";

/** The ramp-up chunks of a read may use the worker kept free for starts. */
const URGENT_CHUNKS = 6;

/** Chunks requested ahead of the one playing. */
const LOOKAHEAD = 8;
const AHEAD_SECONDS = 30;
/** Kokoro's speaking rate at 1x, roughly. */
const CHARS_PER_SECOND = 13;

interface Job {
  promise: Promise<Audio>;
  /** Resolved successfully, i.e. ready to play or already playing. */
  done: boolean;
}

class Player {
  state: PlayerState = "idle";
  /** Bumped on every start/stop; async work from an older session bails out. */
  private session = 0;
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  /**
   * Timing of the current read: how long until the first audio, and every
   * pause between chunks while waiting for synthesis (milliseconds).
   */
  stats = { firstAudioMs: 0, gapsMs: [] as number[], skipped: [] as string[] };
  /** Chunks of the current read (read-only outside this class). */
  sentences: string[] = [];
  /** jobs[i] is the synthesis of sentences[i]; filled ahead of `index`. */
  private jobs: Job[] = [];
  /** Chunk being played (read-only outside this class). */
  index = 0;

  /** Show the bar right away while the text to read is being gathered. */
  prepare() {
    this.stop();
    this.setState("loading");
    bar.show();
    bar.setStatus(getString("bar-reading-document"));
  }

  /** Read one text, or several paragraphs in order. */
  async readText(raw: string | string[]): Promise<void> {
    const sentences = prepareSpeech(raw, {
      stripCitations: getPref("stripCitations"),
    });
    if (!sentences.length) return;
    this.stop();
    const session = ++this.session;
    this.sentences = sentences;
    this.jobs = [];
    this.index = 0;
    this.setState("loading");
    bar.show();
    const started = Date.now();
    let lastEnd = 0;
    this.stats = { firstAudioMs: 0, gapsMs: [], skipped: [] };

    try {
      await engine.ensureReady((fraction) => {
        if (session === this.session) bar.setDownloadProgress(fraction);
      });
      if (session !== this.session) return;
      bar.setLoading();
      let failures = 0;
      for (; this.index < sentences.length; this.index++) {
        this.prefetch();
        let audio: Audio;
        try {
          audio = await this.awaitJob(this.index);
        } catch (e) {
          if (session !== this.session) return;
          // One chunk the model can't voice shouldn't end the whole read;
          // say which one was skipped. Repeated failures mean something
          // is broken, so stop then.
          if (++failures >= 3) throw e;
          ztoolkit.log("Chunk failed, skipping", sentences[this.index], e);
          this.stats.skipped.push(sentences[this.index]);
          bar.setStatus(
            getString("bar-chunk-failed", {
              args: { text: sentences[this.index] },
            }),
          );
          continue;
        }
        failures = 0;
        if (session !== this.session) return;
        bar.setSentence(sentences[this.index], this.index, sentences.length);
        if (this.state === "loading") this.setState("playing");
        if (this.index === 0) this.stats.firstAudioMs = Date.now() - started;
        else if (this.state === "playing")
          this.stats.gapsMs.push(Date.now() - lastEnd);
        // If the next chunk isn't ready, keep this chunk's natural pause so
        // the wait sounds like a pause rather than a stall.
        const nextReady = this.jobs[this.index + 1]?.done ?? true;
        await this.play(audio, sentences[this.index], nextReady);
        if (session !== this.session) return;
        lastEnd = Date.now();
      }
      this.stop();
    } catch (e) {
      if (session !== this.session) return;
      ztoolkit.log("Read aloud failed", e);
      this.stop();
      showError(e);
    }
  }

  togglePause() {
    if (!this.ctx) return;
    if (this.state === "playing") {
      this.ctx.suspend();
      this.setState("paused");
    } else if (this.state === "paused") {
      this.ctx.resume();
      this.setState("playing");
    }
  }

  /** Re-synthesize upcoming sentences after the voice or speed changed. */
  settingsChanged() {
    if (this.state === "idle" || !this.jobs.length) return;
    engine.clear();
    // Keep the sentence that is already playing; redo everything after it.
    const keep = this.jobs[this.index]?.done ? this.index + 1 : this.index;
    this.jobs.length = Math.min(this.jobs.length, keep);
    this.prefetch();
  }

  /** Await sentence `i`, following replacements made by `settingsChanged`. */
  private async awaitJob(i: number): Promise<Audio> {
    for (;;) {
      const job = this.jobs[i];
      try {
        return await job.promise;
      } catch (e) {
        if (this.jobs[i] && this.jobs[i] !== job) continue;
        throw e;
      }
    }
  }

  stop() {
    this.session++;
    engine.clear();
    this.jobs = [];
    this.sentences = [];
    const source = this.source;
    this.source = null;
    try {
      source?.stop();
    } catch {
      // Already stopped.
    }
    if (this.ctx?.state === "suspended") this.ctx.resume();
    this.setState("idle");
    bar.hide();
  }

  /** Called when the main window goes away: the AudioContext belongs to it. */
  reset() {
    this.stop();
    this.ctx?.close();
    this.ctx = null;
  }

  private prefetch() {
    // The engine queues these and hands them to workers as they free up, so
    // queuing ahead costs nothing until a worker is idle.
    // Stop at LOOKAHEAD chunks or about AHEAD_SECONDS of speech, whichever
    // comes first, so a switch abandons little work.
    const until = Math.min(this.sentences.length, this.index + LOOKAHEAD);
    let ahead = this.sentences
      .slice(this.index + 1, this.jobs.length)
      .reduce((n, s) => n + s.length, 0);
    while (
      this.jobs.length < until &&
      ahead < AHEAD_SECONDS * CHARS_PER_SECOND
    ) {
      ahead += this.sentences[this.jobs.length].length;
      this.jobs.push(this.synth(this.jobs.length));
    }
  }

  private synth(index: number): Job {
    const voice = getPref("voice") || "af_heart";
    const speed = Number(getPref("speed")) || 1;
    const urgent = index < URGENT_CHUNKS;
    const promise = engine.synth(this.sentences[index], voice, speed, {
      urgent,
    });
    const job: Job = { promise, done: false };
    // Sentences prefetched for a stopped session are never awaited.
    job.promise.then(
      () => (job.done = true),
      () => {},
    );
    return job;
  }

  private play(audio: Audio, text: string, nextReady: boolean): Promise<void> {
    const ctx = (this.ctx ??= new (Zotero.getMainWindow().AudioContext)());
    const pcm = trimSilence(audio.pcm, audio.sampleRate, {
      tail: nextReady ? pauseAfter(text) : 0.5,
    });
    if (!pcm.length) return Promise.resolve();
    const buffer = ctx.createBuffer(1, pcm.length, audio.sampleRate);
    buffer.copyToChannel(pcm, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    this.source = source;
    return new Promise((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
  }

  private setState(state: PlayerState) {
    this.state = state;
    bar.setState(state);
  }
}

function showError(e: unknown) {
  new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: 8000,
  })
    .createLine({
      text: getString("error", { args: { message: String(e) } }),
      type: "fail",
    })
    .show();
}

export const player = new Player();
