/**
 * Kokoro pads every clip with about 0.35 s of silence before and 0.45 s
 * after the speech. Between chunks that adds up to 0.8 s of dead air, which
 * sounds like stuttering when a sentence was split into several chunks, and
 * it delays the first word. Trim it and keep a pause that fits the text.
 */

const THRESHOLD = 0.01;

/** Pause to keep after a chunk, in seconds, judged by how its text ends. */
export function pauseAfter(text: string): number {
  if (/[.!?]["'”)\]]?$/.test(text)) return 0.3;
  if (/[,;:]$/.test(text)) return 0.15;
  return 0.04;
}

export function trimSilence(
  pcm: Float32Array,
  sampleRate: number,
  { lead = 0.03, tail = 0.3 } = {},
): Float32Array {
  let first = 0;
  while (first < pcm.length && Math.abs(pcm[first]) < THRESHOLD) first++;
  if (first === pcm.length) return pcm.subarray(0, 0);
  let last = pcm.length - 1;
  while (last > first && Math.abs(pcm[last]) < THRESHOLD) last--;
  const start = Math.max(0, first - Math.round(lead * sampleRate));
  const end = Math.min(pcm.length, last + 1 + Math.round(tail * sampleRate));
  return pcm.subarray(start, end);
}
