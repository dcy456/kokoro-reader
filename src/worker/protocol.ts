/** Messages between the main thread (src/modules/engine.ts) and the TTS worker. */

export type Dtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

export type WorkerRequest =
  | {
      type: "init";
      modelId: string;
      dtype: Dtype;
      /** Folder URL holding ORT's wasm glue module and binary. */
      wasmPaths: string;
      /** Repo-relative file name -> contents, e.g. "onnx/model_quantized.onnx". */
      files: Record<string, ArrayBuffer>;
    }
  | { type: "voice"; name: string; data: ArrayBuffer }
  | {
      type: "synth";
      id: number;
      text: string;
      voice: string;
      speed: number;
      /** Retry reworded when the output is NaN (default true; off in tests). */
      retry?: boolean;
    }
  /** Drop queued synth requests; the one in progress still finishes. */
  | { type: "clear" };

export type WorkerResponse =
  | {
      type: "ready";
      crossOriginIsolated: boolean;
      sharedArrayBuffer: boolean;
      threads: number;
    }
  | {
      type: "audio";
      id: number;
      pcm: Float32Array;
      sampleRate: number;
      elapsedMs: number;
      /** The first attempt returned NaN audio; a reworded retry succeeded. */
      retried: boolean;
    }
  | { type: "error"; id?: number; message: string };
