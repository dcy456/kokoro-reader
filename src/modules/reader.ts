/**
 * Hooks into the Zotero reader: "Read aloud" and "Read from here" buttons in
 * the text selection popup, matching context menu items, and a shortcut.
 */
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import type { SourcePosition } from "./document";

/**
 * The most recent selection and the buttons we added to its popup. The popup
 * (and our buttons with it) is removed when the selection goes away, so a
 * disconnected button means the text is no longer selected.
 */
let lastSelection: {
  text: string;
  position: SourcePosition | null;
  reader: _ZoteroTypes.ReaderInstance;
  button: Element;
} | null = null;

export function currentSelection(): string | null {
  return lastSelection?.button.isConnected ? lastSelection.text : null;
}

function selectionIn(reader: _ZoteroTypes.ReaderInstance) {
  return lastSelection?.button.isConnected && lastSelection.reader === reader
    ? lastSelection
    : null;
}

function makeButton(doc: Document, label: string, title: string) {
  const button = doc.createElement("button");
  button.textContent = label;
  button.title = title;
  Object.assign(button.style, {
    flex: "1",
    padding: "4px 8px",
    border: "1px solid var(--material-border-quarternary, #ccc)",
    borderRadius: "5px",
    background: "var(--material-button, transparent)",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
  });
  return button;
}

const onTextSelectionPopup: _ZoteroTypes.Reader.EventHandler<
  "renderTextSelectionPopup"
> = ({ reader, doc, params, append }) => {
  const text = params.annotation.text ?? "";
  if (!text.trim()) return;
  const position =
    (params.annotation.position as unknown as SourcePosition) ?? null;

  const row = doc.createElement("div");
  Object.assign(row.style, { display: "flex", gap: "6px", marginTop: "6px" });
  const readButton = makeButton(
    doc,
    `\u{1F50A} ${getString("read-aloud")}`,
    getString("read-aloud-tooltip", {
      args: { shortcut: formatShortcut(getPref("shortcut")) },
    }),
  );
  readButton.addEventListener("click", () => addon.hooks.onReadText(text));
  const fromHereButton = makeButton(
    doc,
    `\u23E9 ${getString("read-from-here")}`,
    getString("read-from-here-tooltip"),
  );
  fromHereButton.addEventListener("click", () =>
    addon.hooks.onReadFrom(reader, position, text),
  );
  row.append(readButton, fromHereButton);
  append(row);
  lastSelection = { text, position, reader, button: readButton };
};

const onViewContextMenu: _ZoteroTypes.Reader.EventHandler<
  "createViewContextMenu"
> = ({ reader, params, append }) => {
  const selection = selectionIn(reader);
  // Where the user right-clicked, when Zotero passes it along; otherwise
  // the selection, otherwise the current page.
  const clicked = (params as { position?: SourcePosition }).position ?? null;
  const items: Array<Parameters<typeof append>[0]> = [];
  if (selection) {
    const text = selection.text;
    items.push({
      label: getString("menu-read-selection"),
      onCommand: () => addon.hooks.onReadText(text),
    });
  }
  const position = clicked ?? selection?.position ?? null;
  const fallbackText = selection?.text;
  items.push({
    label: getString("menu-read-from-here"),
    onCommand: () => addon.hooks.onReadFrom(reader, position, fallbackText),
  });
  // One call keeps the items in one group (each call adds a separator).
  (append as (...menuItems: typeof items) => void)(...items);
};

export function registerReaderHooks() {
  const pluginID = addon.data.config.addonID;
  // Passing the plugin ID lets Zotero drop these listeners when the plugin
  // is disabled or uninstalled.
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    onTextSelectionPopup,
    pluginID,
  );
  Zotero.Reader.registerEventListener(
    "createViewContextMenu",
    onViewContextMenu,
    pluginID,
  );
}

export function unregisterReaderHooks() {
  Zotero.Reader.unregisterEventListener(
    "renderTextSelectionPopup",
    onTextSelectionPopup,
  );
  Zotero.Reader.unregisterEventListener(
    "createViewContextMenu",
    onViewContextMenu,
  );
  lastSelection = null;
}

/**
 * Listen for the shortcut in the main window and in reader iframes. Keys are
 * matched by `event.code`: on macOS, Option changes `event.key` (Option+R
 * types "®"), so comparing characters would never match.
 */
export function registerShortcut() {
  ztoolkit.Keyboard.register((event, { type }) => {
    if (type !== "keydown" || !matchesShortcut(event, getPref("shortcut"))) {
      return;
    }
    event.preventDefault();
    addon.hooks.onShortcut();
  });
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  const parts = shortcut
    .toLowerCase()
    .split(/[,+]/)
    .map((p) => p.trim());
  const key = parts.pop();
  if (!key) return false;
  const has = (...names: string[]) => names.some((n) => parts.includes(n));
  const accel = has("accel");
  const wanted = {
    alt: has("alt", "option"),
    shift: has("shift"),
    ctrl: has("ctrl", "control") || (accel && !Zotero.isMac),
    meta: has("meta", "cmd", "command") || (accel && Zotero.isMac),
  };
  if (
    event.altKey !== wanted.alt ||
    event.shiftKey !== wanted.shift ||
    event.ctrlKey !== wanted.ctrl ||
    event.metaKey !== wanted.meta
  ) {
    return false;
  }
  const code = event.code.toLowerCase();
  return code === `key${key}` || code === `digit${key}` || code === key;
}

export function formatShortcut(shortcut: string): string {
  const names: Record<string, string> = Zotero.isMac
    ? { alt: "⌥", shift: "⇧", control: "⌃", ctrl: "⌃", meta: "⌘", accel: "⌘" }
    : {
        alt: "Alt+",
        shift: "Shift+",
        control: "Ctrl+",
        ctrl: "Ctrl+",
        meta: "Win+",
        accel: "Ctrl+",
      };
  const parts = shortcut
    .toLowerCase()
    .split(/[,+]/)
    .map((p) => p.trim());
  const key = parts.pop() ?? "";
  return parts.map((p) => names[p] ?? `${p}+`).join("") + key.toUpperCase();
}
