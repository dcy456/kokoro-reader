/**
 * Main-thread side of Kokoro TTS: downloads and caches model files on disk,
 * owns the worker, and turns worker messages into promises.
 */
import type { Dtype, WorkerRequest, WorkerResponse } from "../worker/protocol";
import { config } from "../../package.json";
import { getPref } from "../utils/prefs";

export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const MODEL_DIR_NAME = "Kokoro-82M-v1.0-ONNX";

const WEIGHTS: Record<Dtype, string> = {
  fp32: "onnx/model.onnx",
  fp16: "onnx/model_fp16.onnx",
  q8: "onnx/model_quantized.onnx",
  q4: "onnx/model_q4.onnx",
  q4f16: "onnx/model_q4f16.onnx",
};
const CONFIG_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json"];

export type ProgressCallback = (fraction: number) => void;

export interface Audio {
  pcm: Float32Array;
  sampleRate: number;
}

export function getDtype(): Dtype {
  const dtype = getPref("dtype") as Dtype;
  return dtype in WEIGHTS ? dtype : "fp16";
}

export function getModelDir(): string {
  const custom = getPref("modelDir");
  const base =
    custom || PathUtils.join(Zotero.DataDirectory.dir, "kokororeader");
  return PathUtils.join(base, MODEL_DIR_NAME);
}

function localPath(file: string): string {
  return PathUtils.join(getModelDir(), ...file.split("/"));
}

function remoteURL(file: string): string {
  const host = (getPref("mirror") || "https://huggingface.co").replace(
    /\/+$/,
    "",
  );
  return `${host}/${MODEL_ID}/resolve/main/${file}`;
}

export async function isModelDownloaded(dtype = getDtype()): Promise<boolean> {
  const files = [...CONFIG_FILES, WEIGHTS[dtype]];
  const exists = await Promise.all(
    files.map((f) => IOUtils.exists(localPath(f))),
  );
  return exists.every(Boolean);
}

export async function clearModelCache(): Promise<void> {
  engine.destroy();
  await IOUtils.remove(getModelDir(), { recursive: true, ignoreAbsent: true });
}

/**
 * Download `files` that are not cached yet. Progress is reported over the
 * total bytes of the missing files. Each file is written to a `.part` file and
 * renamed when complete, so an interrupted download never looks finished.
 */
async function downloadMissing(
  files: string[],
  onProgress?: ProgressCallback,
): Promise<void> {
  const missing: string[] = [];
  for (const file of files) {
    if (!(await IOUtils.exists(localPath(file)))) missing.push(file);
  }
  if (!missing.length) return;

  const win = Zotero.getMainWindow();
  const responses = await Promise.all(
    missing.map(async (file) => {
      const response = await win.fetch(remoteURL(file));
      if (!response.ok || !response.body) {
        throw new Error(
          `Download failed (${response.status}): ${remoteURL(file)}`,
        );
      }
      return { file, response };
    }),
  );
  const total = responses.reduce(
    (sum, { response }) =>
      sum + Number(response.headers.get("content-length") || 0),
    0,
  );
  let received = 0;
  onProgress?.(0);

  for (const { file, response } of responses) {
    const target = localPath(file);
    const part = `${target}.part`;
    await IOUtils.makeDirectory(PathUtils.parent(target)!, {
      ignoreExisting: true,
    });
    await IOUtils.remove(part, { ignoreAbsent: true });
    const reader =
      response.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const CHUNK_BUFFER_SIZE = 1024 * 1024; // 1 MB buffer to batch writes and avoid UI stutter
    let buffer: Uint8Array[] = [];
    let bufferBytes = 0;
    const flush = async () => {
      if (!buffer.length) return;
      const merged = new Uint8Array(bufferBytes);
      let offset = 0;
      for (const chunk of buffer) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      await IOUtils.write(part, merged, { mode: "appendOrCreate" });
      buffer = [];
      bufferBytes = 0;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        await flush();
        break;
      }
      buffer.push(value);
      bufferBytes += value.byteLength;
      received += value.byteLength;
      if (bufferBytes >= CHUNK_BUFFER_SIZE) {
        await flush();
      }
      if (total) onProgress?.(Math.min(received / total, 1));
    }
    await IOUtils.move(part, target);
  }
  onProgress?.(1);
}

async function readBuffer(path: string): Promise<ArrayBuffer> {
  const bytes = await IOUtils.read(path);
  // Avoid copying a 160 MB model when the array already owns its buffer.
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

interface Job {
  id: number;
  retry: boolean;
  /** The start of a read: may use the worker kept free for starts. */
  urgent: boolean;
  text: string;
  voice: string;
  speed: number;
  resolve: (audio: Audio) => void;
  reject: (error: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  /** Resolves once the model is loaded in this worker. */
  ready: Promise<void>;
  loaded: boolean;
  /** The one job this worker is synthesizing, if any. */
  current: { job: Job; startedAt: number; abandoned: boolean } | null;
}

/**
 * Default pool size: each worker holds its own copy of the model (~290 MB)
 * and runs single-threaded, so more cores allow more workers.
 */
export function defaultPoolSize(): number {
  const cores = Zotero.getMainWindow().navigator.hardwareConcurrency || 4;
  if (cores >= 12) return 4;
  if (cores >= 9) return 3;
  if (cores >= 6) return 2;
  return 1;
}

/**
 * Runs Kokoro in a pool of workers. Chrome workers have no SharedArrayBuffer,
 * so ONNX Runtime is single-threaded; synthesizing different sentences on
 * several workers at once is how playback gets faster than real time.
 *
 * Jobs wait in one shared queue and each worker takes the next job only when
 * it is idle, so a job never waits behind another job on a busy worker while
 * a different worker is free.
 */
class Engine {
  private pool: PoolWorker[] = [];
  private queue: Job[] = [];
  private readyPromise: Promise<void> | null = null;
  /** Model files of the loaded pool, for replacing workers. */
  private model: { dtype: Dtype; files: string[] } | null = null;
  /** Bumped by `destroy()`; workers spawned for an older pool are dropped. */
  private epoch = 0;
  private voices = new Map<string, Promise<ArrayBuffer>>();
  private nextId = 1;
  /** Bumped by `clear()`; requests still loading from an older generation are dropped. */
  private generation = 0;
  private idleTimer: number | null = null;
  /** Learned costs: synthesis time per character, and time to load a worker. */
  private msPerChar = 80;
  private loadMs = 3000;
  /** Chunks whose first synthesis was NaN and a retry fixed (see retry.ts). */
  rescued = 0;
  /** Seconds of audio per second of compute for the last request (>1 = faster than real time). */
  lastSpeedFactor = 0;
  /** Overrides the pool size (tests and benchmarks); 0 = pref or default. */
  poolSize = 0;
  /** What the first worker reported once the model loaded. */
  info: Extract<WorkerResponse, { type: "ready" }> | null = null;

  /** Number of workers in the pool, loaded or still loading. */
  get size(): number {
    return this.pool.length;
  }

  /** Whether every worker has the model loaded. */
  get loaded(): boolean {
    return this.pool.length > 0 && this.pool.every((m) => m.loaded);
  }

  /**
   * Load the model in the background if it is already downloaded, so the
   * first read doesn't wait for it. Never starts a download by itself.
   */
  async warmUp(): Promise<void> {
    if (this.readyPromise || !(await isModelDownloaded())) return;
    await this.ensureReady().catch((e) =>
      Zotero.debug(`[Kokoro Reader] warm-up failed: ${e}`),
    );
    this.scheduleUnload();
  }

  /** Download (if needed) and load the model. Safe to call repeatedly. */
  ensureReady(onProgress?: ProgressCallback): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.start(onProgress).catch((e) => {
        this.destroy();
        throw e;
      });
    }
    return this.readyPromise;
  }

  private resolvePoolSize(): number {
    return this.poolSize || Number(getPref("workers")) || defaultPoolSize();
  }

  private async start(onProgress?: ProgressCallback): Promise<void> {
    const dtype = getDtype();
    const files = [...CONFIG_FILES, WEIGHTS[dtype]];
    await downloadMissing(files, onProgress);
    this.model = { dtype, files };
    const size = this.resolvePoolSize();
    // Workers load in parallel; each needs its own copy of the weights.
    const members = Array.from({ length: size }, () => this.spawn());
    // Ready as soon as one worker can speak; the others join when loaded.
    await Promise.any(members.map((m) => m.ready));
  }

  private spawn(): PoolWorker {
    const { dtype, files } = this.model!;
    const epoch = this.epoch;
    const spawnedAt = Date.now();
    const worker = new (Zotero.getMainWindow().Worker)(
      `chrome://${config.addonRef}/content/scripts/tts-worker.js`,
      { type: "module" },
    );
    const member = { worker, loaded: false, current: null } as PoolWorker;
    member.ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data as WorkerResponse;
        if (msg.type === "ready") {
          this.info ??= msg;
          member.loaded = true;
          this.loadMs = 0.7 * this.loadMs + 0.3 * (Date.now() - spawnedAt);
          Zotero.debug(
            `[Kokoro Reader] TTS worker ready in ${Date.now() - spawnedAt} ms`,
          );
          resolve();
          this.pump();
        } else if (msg.type === "error" && msg.id === undefined) {
          reject(new Error(msg.message));
        } else {
          this.onWorkerMessage(member, msg);
        }
      };
      worker.onerror = (event: ErrorEvent) => {
        reject(new Error(event.message || "TTS worker failed to start"));
      };
    });
    member.ready.catch(() => {
      this.pool = this.pool.filter((m) => m !== member);
    });
    this.pool.push(member);

    (async () => {
      const contents: Record<string, ArrayBuffer> = {};
      for (const file of files) {
        contents[file] = await readBuffer(localPath(file));
      }
      // Voices that earlier workers already have.
      const voices = await Promise.all(
        [...this.voices].map(async ([name, data]) => ({
          name,
          data: (await data).slice(0),
        })),
      );
      if (epoch !== this.epoch) return;
      const init: WorkerRequest = {
        type: "init",
        modelId: MODEL_ID,
        dtype,
        wasmPaths: `chrome://${config.addonRef}/content/ort/`,
        files: contents,
      };
      worker.postMessage(init, Object.values(contents));
      for (const { name, data } of voices) {
        const msg: WorkerRequest = { type: "voice", name, data };
        worker.postMessage(msg, [data]);
      }
    })().catch((e) => Zotero.debug(`[Kokoro Reader] spawn failed: ${e}`));
    return member;
  }

  /**
   * Give queued jobs to idle loaded workers, oldest job first. With three or
   * more workers, one is kept free for the start of the next read, so
   * switching to another passage doesn't wait for synthesis queued ahead.
   */
  private pump() {
    const reserve = this.pool.length >= 3 ? 1 : 0;
    for (const member of this.pool) {
      if (!this.queue.length) return;
      if (!member.loaded || member.current) continue;
      const idle = this.pool.filter((m) => m.loaded && !m.current).length;
      const index = this.queue.findIndex((j) => j.urgent || idle > reserve);
      if (index === -1) return;
      const [job] = this.queue.splice(index, 1);
      member.current = { job, startedAt: Date.now(), abandoned: false };
      const request: WorkerRequest = {
        type: "synth",
        id: job.id,
        text: job.text,
        voice: job.voice,
        speed: job.speed,
        retry: job.retry,
      };
      member.worker.postMessage(request);
    }
  }

  private onWorkerMessage(member: PoolWorker, msg: WorkerResponse) {
    if (msg.type !== "audio" && msg.type !== "error") return;
    const current = member.current;
    if (!current || current.job.id !== msg.id) return;
    member.current = null;
    if (msg.type === "audio") {
      const seconds = msg.pcm.length / msg.sampleRate;
      this.lastSpeedFactor = seconds / (msg.elapsedMs / 1000);
      if (msg.retried) {
        this.rescued++;
        Zotero.debug(
          `[Kokoro Reader] NaN audio, rescued by retry: ${current.job.text}`,
        );
      }
      const perChar = msg.elapsedMs / Math.max(1, current.job.text.length);
      this.msPerChar = 0.8 * this.msPerChar + 0.2 * perChar;
      if (!current.abandoned) {
        current.job.resolve({ pcm: msg.pcm, sampleRate: msg.sampleRate });
      }
    } else if (!current.abandoned) {
      current.job.reject(new Error(msg.message));
    }
    this.pump();
  }

  /**
   * Stop waiting for a worker's current job. ONNX Runtime can't be
   * interrupted, so if the job would take longer to finish than loading a
   * fresh worker, the worker is replaced; otherwise it finishes and its
   * result is dropped.
   */
  private abandon(member: PoolWorker) {
    const current = member.current;
    if (!current || current.abandoned) return;
    current.abandoned = true;
    current.job.reject(new Error("cancelled"));
    const elapsed = Date.now() - current.startedAt;
    const remaining = current.job.text.length * this.msPerChar - elapsed;
    if (remaining > this.loadMs && this.model) {
      member.worker.terminate();
      this.pool = this.pool.filter((m) => m !== member);
      this.spawn();
    }
  }

  private ensureVoice(voice: string): Promise<ArrayBuffer> {
    let data = this.voices.get(voice);
    if (!data) {
      const file = `voices/${voice}.bin`;
      data = downloadMissing([file]).then(() => readBuffer(localPath(file)));
      data.then(
        (buffer) => {
          for (const { worker } of this.pool) {
            const copy = buffer.slice(0);
            const msg: WorkerRequest = {
              type: "voice",
              name: voice,
              data: copy,
            };
            worker.postMessage(msg, [copy]);
          }
        },
        () => this.voices.delete(voice),
      );
      this.voices.set(voice, data);
    }
    return data;
  }

  async synth(
    text: string,
    voice: string,
    speed: number,
    { urgent = false, retry = true } = {},
  ): Promise<Audio> {
    const generation = this.generation;
    await this.ensureReady();
    await this.ensureVoice(voice);
    if (generation !== this.generation) throw new Error("cancelled");
    this.scheduleUnload();
    return new Promise<Audio>((resolve, reject) => {
      this.queue.push({
        id: this.nextId++,
        urgent,
        retry,
        text,
        voice,
        speed,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  /** Drop all outstanding requests; their promises reject with "cancelled". */
  clear() {
    this.generation++;
    for (const job of this.queue.splice(0)) {
      job.reject(new Error("cancelled"));
    }
    for (const member of [...this.pool]) {
      member.worker.postMessage({ type: "clear" });
      this.abandon(member);
    }
  }

  /** Free the workers' memory after a while without reading. */
  private scheduleUnload() {
    const win = Zotero.getMainWindow();
    if (this.idleTimer !== null) win.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const minutes = Number(getPref("unloadAfterMinutes"));
    if (!(minutes > 0)) return;
    this.idleTimer = win.setTimeout(() => {
      this.idleTimer = null;
      const busy = this.queue.length || this.pool.some((m) => m.current);
      if (busy) this.scheduleUnload();
      else this.destroy();
    }, minutes * 60_000);
  }

  destroy() {
    if (this.idleTimer !== null) {
      Zotero.getMainWindow()?.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.epoch++;
    this.model = null;
    this.clear();
    for (const { worker } of this.pool) worker.terminate();
    this.pool = [];
    this.readyPromise = null;
    this.voices.clear();
    this.info = null;
  }
}

export const engine = new Engine();
