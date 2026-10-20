/**
 * What to try when the model returns NaN audio for a chunk.
 *
 * With the fp16 weights on ONNX Runtime's wasm backend, about 1 chunk in 20
 * of real paper text overflows and the whole waveform comes out NaN, which
 * plays as silence ("Theorem 1.", "Using ZK proofs,"). fp32 weights don't
 * have this problem but need 2.4x the memory. The failure is deterministic
 * for a given input, so retrying unchanged doesn't help; a slightly
 * different speed or final punctuation does. Measured on 21 failing chunks
 * from three papers: speed x1.05 fixed 18, dropping the final punctuation
 * 16, ending with a period 9, and together all 21.
 */
export interface Attempt {
  text: string;
  speed: number;
}

export function retryAttempts(text: string, speed: number): Attempt[] {
  const bare = text.replace(/[.,;:!?]+$/, "");
  const attempts: Attempt[] = [
    { text, speed: speed * 1.05 },
    { text: bare, speed },
    { text: `${bare}.`, speed },
    { text, speed: speed * 0.95 },
    { text: bare, speed: speed * 1.05 },
    { text: `${bare}.`, speed: speed * 1.05 },
  ];
  const seen = new Set([`${text}|${speed}`]);
  return attempts.filter((a) => {
    const key = `${a.text}|${a.speed}`;
    if (!a.text.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
