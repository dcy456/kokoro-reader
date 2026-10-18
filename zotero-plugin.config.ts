import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

// The wasm-only ONNX Runtime build (no WebGPU) is ~11 MB instead of ~21 MB.
const ORT_BUNDLE = "node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs";
// ORT loads its wasm glue module and binary from `wasmPaths` at runtime.
const ORT_FILES = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
      {
        // Kokoro TTS runs in a module worker so synthesis never blocks the UI.
        entryPoints: ["src/worker/tts.worker.ts"],
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "firefox115",
        minify: process.env.NODE_ENV === "production",
        alias: { "onnxruntime-web": `./${ORT_BUNDLE}` },
        outfile: ".scaffold/build/addon/content/scripts/tts-worker.js",
      },
    ],
    hooks: {
      "build:copyAssets": async (ctx) => {
        const dir = `${ctx.dist}/addon/content/ort`;
        await mkdir(dir, { recursive: true });
        for (const file of ORT_FILES) {
          await copyFile(
            `node_modules/onnxruntime-web/dist/${file}`,
            `${dir}/${file}`,
          );
        }
      },
    },
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
    // Keep downloaded model files across test runs (the test data dir is wiped
    // every run). CI leaves this unset, which skips the synthesis test.
    prefs: {
      // Lets tests find test/fixtures from inside Zotero.
      "extensions.kokororeader-test.fixtures": resolve("test/fixtures"),
      ...(process.env.CI
        ? {}
        : {
            [`${pkg.config.prefsPrefix}.modelDir`]: resolve(
              ".scaffold/model-cache",
            ),
          }),
    },
    mocha: { timeout: 20000 },
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
