/**
 * English Kokoro voices, best first (grades from the Kokoro-82M model card).
 * `id` prefixes: a = American, b = British; f = female, m = male.
 */
export const VOICES: Array<{ id: string; name: string; grade: string }> = [
  { id: "af_heart", name: "Heart", grade: "A" },
  { id: "af_bella", name: "Bella", grade: "A-" },
  { id: "af_nicole", name: "Nicole", grade: "B-" },
  { id: "bf_emma", name: "Emma", grade: "B-" },
  { id: "af_aoede", name: "Aoede", grade: "C+" },
  { id: "af_kore", name: "Kore", grade: "C+" },
  { id: "af_sarah", name: "Sarah", grade: "C+" },
  { id: "am_fenrir", name: "Fenrir", grade: "C+" },
  { id: "am_michael", name: "Michael", grade: "C+" },
  { id: "am_puck", name: "Puck", grade: "C+" },
  { id: "bm_fable", name: "Fable", grade: "C" },
  { id: "bm_george", name: "George", grade: "C" },
  { id: "bf_isabella", name: "Isabella", grade: "C" },
  { id: "af_alloy", name: "Alloy", grade: "C" },
  { id: "af_nova", name: "Nova", grade: "C" },
  { id: "af_sky", name: "Sky", grade: "C-" },
  { id: "bm_lewis", name: "Lewis", grade: "D+" },
];

export function voiceLabel(id: string): string {
  const voice = VOICES.find((v) => v.id === id);
  if (!voice) return id;
  const accent = id.startsWith("b") ? "UK" : "US";
  const gender = id[1] === "f" ? "♀" : "♂";
  return `${voice.name} (${accent} ${gender})`;
}

export const SPEEDS = [
  "0.8",
  "0.9",
  "1.0",
  "1.1",
  "1.25",
  "1.5",
  "1.75",
  "2.0",
];
