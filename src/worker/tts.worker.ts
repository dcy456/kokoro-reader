/**
 * Kokoro TTS worker.
 *
 * The main thread owns downloading and caching model files (it can write to
 * disk, this worker cannot). It hands the bytes over in an `init` message, and
 * this worker serves them to transformers.js and kokoro-js through in-memory
 * caches, so nothing here touches the network.
 */
import { env } from "@huggingface/transformers";
import { KokoroTTS, type GenerateOptions } from "kokoro-js";
import type { WorkerRequest, WorkerResponse } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const modelFiles = new Map<string, ArrayBuffer>();
const voiceFiles = new Map<string, ArrayBuffer>();
let tts: KokoroTTS | null = null;
// Synthesis runs one request at a time; `generation` lets `clear` drop
// requests that were queued before it.
let queue: Promise<void> = Promise.resolve();
let generation = 0;

function findModelFile(url: string): ArrayBuffer | undefined {
  for (const [name, data] of modelFiles) {
    if (url.endsWith(`/${name}`)) return data;
  }
  return undefined;
}

env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = {
  match: async (request: string | Request) => {
    const data = findModelFile(String(request));
    return data ? new Response(data) : undefined;
  },
  put: async () => {},
};

// kokoro-js loads voice embeddings through `caches.open("kokoro-voices")`.
Object.defineProperty(self, "caches", {
  configurable: true,
  value: {
    open: async () => ({
      match: async (url: string) => {
        const name = /voices\/([\w-]+)\.bin$/.exec(String(url))?.[1];
        const data = name ? voiceFiles.get(name) : undefined;
        return data ? new Response(data) : undefined;
      },
      put: async () => {},
    }),
  },
});

function post(message: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(message, transfer);
}

async function init(
  msg: Extract<WorkerRequest, { type: "init" }>,
): Promise<void> {
  for (const [name, data] of Object.entries(msg.files)) {
    modelFiles.set(name, data);
  }
  const wasm = env.backends.onnx.wasm!;
  wasm.wasmPaths = msg.wasmPaths;
  // Multi-threaded wasm needs SharedArrayBuffer, which chrome workers lack;
  // the main thread runs a pool of single-threaded workers instead.
  wasm.numThreads = 1;
  tts = await KokoroTTS.from_pretrained(msg.modelId, {
    dtype: msg.dtype,
    device: "wasm",
  });
  // The model is loaded into ORT now; drop our copy of the weights.
  modelFiles.clear();
  post({
    type: "ready",
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    threads: wasm.numThreads ?? 0,
  });
}

async function synth(
  msg: Extract<WorkerRequest, { type: "synth" }>,
  requestGeneration: number,
): Promise<void> {
  if (requestGeneration !== generation) return;
  if (!tts) throw new Error("Model is not loaded");
  const started = performance.now();
  const audio = await tts.generate(msg.text, {
    voice: msg.voice as GenerateOptions["voice"],
    speed: msg.speed,
  });
  const pcm = audio.audio as Float32Array;
  post(
    {
      type: "audio",
      id: msg.id,
      pcm,
      sampleRate: audio.sampling_rate,
      elapsedMs: performance.now() - started,
    },
    [pcm.buffer],
  );
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      init(msg).catch((e) => post({ type: "error", message: String(e) }));
      break;
    case "voice":
      voiceFiles.set(msg.name, msg.data);
      break;
    case "synth": {
      const requestGeneration = generation;
      queue = queue
        .then(() => synth(msg, requestGeneration))
        .catch((e) => post({ type: "error", id: msg.id, message: String(e) }));
      break;
    }
    case "clear":
      generation++;
      break;
  }
};
