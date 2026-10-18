import { initLocale, getString } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { engine } from "./modules/engine";
import { player } from "./modules/player";
import { bar } from "./modules/bar";
import {
  currentSelection,
  registerReaderHooks,
  registerShortcut,
  unregisterReaderHooks,
} from "./modules/reader";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { getTextFrom, type SourcePosition } from "./modules/document";
import { getPref } from "./utils/prefs";

let notifierID: string | null = null;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  addon.data.prefsPaneID = await Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/icon.svg`,
  });

  registerReaderHooks();

  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: (event, type, ids, extraData) => {
        if (addon.data.alive) onNotify(event, type, ids, extraData);
      },
    },
    ["tab"],
    addon.data.config.addonRef,
  );
  if (Zotero.Reader._readers.length) preloadModel();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  const style = ztoolkit.UI.createElement(win.document, "link", {
    properties: {
      type: "text/css",
      rel: "stylesheet",
      href: `chrome://${addon.data.config.addonRef}/content/zoteroPane.css`,
    },
  });
  win.document.documentElement?.appendChild(style);
  registerShortcut();
}

async function onMainWindowUnload(win: Window): Promise<void> {
  // The audio context, workers and bar all belong to the main window.
  player.reset();
  engine.destroy();
  bar.destroy();
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  if (notifierID) Zotero.Notifier.unregisterObserver(notifierID);
  notifierID = null;
  player.reset();
  engine.destroy();
  bar.destroy();
  unregisterReaderHooks();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

function onReadText(text: string) {
  player.readText(text);
}

/** Read from a position (or the current page) to the end of the document. */
async function onReadFrom(
  reader: _ZoteroTypes.ReaderInstance,
  position: SourcePosition | null,
  fallbackText?: string,
) {
  player.prepare();
  const texts = await getTextFrom(reader, position);
  if (texts?.length) {
    player.readText(texts);
  } else if (fallbackText) {
    notify(getString("read-from-here-unavailable"));
    player.readText(fallbackText);
  } else {
    player.stop();
    notify(getString("read-from-here-no-text"));
  }
}

function notify(text: string) {
  new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: 4000,
  })
    .createLine({ text, type: "default" })
    .show();
}

/** Load the model in the background so the first read starts quickly. */
function preloadModel() {
  if (getPref("preload")) engine.warmUp();
}

function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // Opening or switching to a reader tab is a good moment to load the model.
  if (
    type === "tab" &&
    (event === "add" || event === "select") &&
    extraData[ids[0]]?.type === "reader"
  ) {
    preloadModel();
  }
}

/** Shortcut toggles: stop if reading, otherwise read the current selection. */
function onShortcut() {
  if (player.state !== "idle") {
    player.stop();
    return;
  }
  const text = currentSelection();
  if (text) {
    player.readText(text);
    return;
  }
  notify(getString("no-selection"));
}

function onBarCommand(command: "toggle" | "stop" | "settings") {
  switch (command) {
    case "toggle":
      player.togglePause();
      break;
    case "stop":
      player.stop();
      break;
    case "settings":
      player.settingsChanged();
      break;
  }
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onReadText,
  onReadFrom,
  onShortcut,
  onBarCommand,
  onPrefsEvent,
};
