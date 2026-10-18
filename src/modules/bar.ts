/**
 * Floating control bar shown at the bottom of the main window while reading:
 * play/pause, stop, current sentence, speed and voice.
 */
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import type { PlayerState } from "./player";
import { SPEEDS, VOICES, voiceLabel } from "./voices";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const BAR_ID = `${config.addonRef}-bar`;

interface BarElements {
  root: HTMLElement;
  toggle: HTMLButtonElement;
  text: HTMLElement;
  speed: HTMLSelectElement;
  voice: HTMLSelectElement;
}

class Bar {
  private elements: BarElements | null = null;

  show() {
    const el = this.ensure();
    el.speed.value = normalizeSpeed(getPref("speed"));
    el.voice.value = getPref("voice");
    el.root.hidden = false;
  }

  hide() {
    if (this.elements) this.elements.root.hidden = true;
  }

  setState(state: PlayerState) {
    const el = this.elements;
    if (!el) return;
    const paused = state === "paused";
    el.toggle.textContent = paused ? "▶" : "⏸";
    el.toggle.title = getString(paused ? "bar-resume" : "bar-pause");
    el.toggle.disabled = state === "loading";
    if (state === "loading") el.text.textContent = getString("bar-loading");
  }

  setLoading() {
    this.setStatus(getString("bar-loading"));
  }

  setStatus(text: string) {
    if (this.elements) this.elements.text.textContent = text;
  }

  setDownloadProgress(fraction: number) {
    if (!this.elements) return;
    this.elements.text.textContent = getString("bar-downloading", {
      args: { percent: Math.round(fraction * 100) },
    });
  }

  setSentence(sentence: string, index: number, total: number) {
    if (!this.elements) return;
    this.elements.text.textContent = sentence;
    this.elements.text.title = `${index + 1} / ${total}`;
  }

  destroy() {
    this.elements?.root.remove();
    this.elements = null;
  }

  private ensure(): BarElements {
    if (this.elements?.root.isConnected) return this.elements;
    const doc = Zotero.getMainWindow().document;
    doc.getElementById(BAR_ID)?.remove();

    const make = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      className: string,
    ) => {
      const node = doc.createElementNS(
        HTML_NS,
        tag,
      ) as HTMLElementTagNameMap[K];
      node.className = `${config.addonRef}-${className}`;
      return node;
    };

    const root = make("div", "bar");
    root.id = BAR_ID;

    const toggle = make("button", "button");
    toggle.addEventListener("click", () => addon.hooks.onBarCommand("toggle"));

    const stop = make("button", "button");
    stop.textContent = "⏹";
    stop.title = getString("bar-stop");
    stop.addEventListener("click", () => addon.hooks.onBarCommand("stop"));

    const text = make("span", "text");

    const speed = make("select", "select");
    speed.title = getString("bar-speed");
    for (const value of SPEEDS) {
      const option = make("option", "option");
      option.value = value;
      option.textContent = `${value}×`;
      speed.append(option);
    }
    speed.addEventListener("change", () => {
      setPref("speed", speed.value);
      addon.hooks.onBarCommand("settings");
    });

    const voice = make("select", "select");
    voice.title = getString("bar-voice");
    for (const v of VOICES) {
      const option = make("option", "option");
      option.value = v.id;
      option.textContent = voiceLabel(v.id);
      voice.append(option);
    }
    voice.addEventListener("change", () => {
      setPref("voice", voice.value);
      addon.hooks.onBarCommand("settings");
    });

    root.append(toggle, stop, text, speed, voice);
    root.hidden = true;
    doc.documentElement!.append(root);
    this.elements = { root, toggle, text, speed, voice };
    return this.elements;
  }
}

function normalizeSpeed(value: string): string {
  const match = SPEEDS.find((s) => Number(s) === Number(value));
  return match ?? "1.0";
}

export const bar = new Bar();
