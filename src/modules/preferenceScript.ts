import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { clearModelCache, engine, getDtype, isModelDownloaded } from "./engine";
import { player } from "./player";

/** Called when the preference pane loads (see addon/content/preferences.xhtml). */
export async function registerPrefsScripts(win: Window) {
  const doc = win.document;
  const $ = (id: string) => doc.getElementById(`${config.addonRef}-${id}`);

  const modelDir = $("model-dir") as HTMLInputElement | null;
  if (modelDir) {
    modelDir.placeholder = PathUtils.join(
      Zotero.DataDirectory.dir,
      config.addonRef,
    );
  }

  const refreshStatus = async () => {
    const status = $("model-status");
    if (!status) return;
    const downloaded = await isModelDownloaded();
    status.setAttribute(
      "value",
      downloaded
        ? getString("prefs-model-ready", { args: { dtype: getDtype() } })
        : getString("prefs-model-missing"),
    );
  };

  $("preview")?.addEventListener("command", () => {
    player.readText(getString("prefs-sample"));
  });

  $("clear-cache")?.addEventListener("command", async () => {
    player.stop();
    await clearModelCache();
    await refreshStatus();
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 3000 })
      .createLine({ text: getString("prefs-cache-cleared"), type: "success" })
      .show();
  });

  // Settings that decide which model gets loaded: unload the current one so
  // the next read picks them up.
  for (const id of ["dtype", "workers", "mirror", "model-dir"]) {
    const el = $(id);
    const reload = () => {
      player.stop();
      engine.destroy();
      // Let the preference binding store the new value first.
      win.setTimeout(refreshStatus, 0);
    };
    el?.addEventListener("command", reload);
    el?.addEventListener("change", reload);
  }

  await refreshStatus();
}
