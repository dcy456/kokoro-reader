import { assert } from "chai";
import { config } from "../package.json";

/** The running plugin instance (not the modules bundled into this test). */
export function plugin(): any {
  return (Zotero as any)[config.addonInstance];
}

export function listener(type: string) {
  const found = (Zotero.Reader as any)._registeredListeners.find(
    (l: any) => l.pluginID === config.addonID && l.type === type,
  );
  assert.exists(found, `${type} listener registered`);
  return found.handler;
}

export async function waitFor(condition: () => boolean, timeout = 120000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting");
    await Zotero.Promise.delay(100);
  }
}
