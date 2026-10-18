/**
 * Turn text selected in a PDF into sentences that read well aloud.
 * Pure functions, no Zotero APIs, so they are easy to test.
 */

export interface CleanOptions {
  stripCitations: boolean;
}

/**
 * Kokoro accepts up to ~510 phoneme tokens; keep chunks well below that.
 * Shorter chunks also spread better over the worker pool.
 */
export const MAX_CHUNK_CHARS = 140;

/**
 * How chunk sizes ramp up at the start of a read. One worker synthesizes
 * slightly slower than real time, so the first chunk must be short for audio
 * to start quickly. Each later chunk is synthesized (on another worker)
 * while the chunks before it play, so it can be about as long as everything
 * queued before it. Measured on real papers, this removes most of the pauses
 * right after starting.
 */
export const RAMP = { first: 16, growth: 0.5 };

const LIGATURES: Record<string, string> = {
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl",
  "\uFB05": "st",
  "\uFB06": "st",
};

// Abbreviations common in papers, expanded so they neither end a sentence
// nor get spelled out letter by letter.
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\be\.\s?g\.(?:,)?/gi, "for example,"],
  [/\bi\.\s?e\.(?:,)?/gi, "that is,"],
  [/\bet al\./g, "et al"],
  [/\bw\.r\.t\./gi, "with respect to"],
  [/\bcf\./gi, "compare"],
  [/\bvs\./gi, "versus"],
  [/\bresp\./gi, "respectively"],
  [/\bapprox\./gi, "approximately"],
  [/\bFigs?\.(?=\s*\d)/g, "Figure"],
  [/\bTabs?\.(?=\s*\d)/g, "Table"],
  [/\bEqs?\.(?=\s*\(?\d)/g, "Equation"],
  [/\bSecs?\.(?=\s*\d)/g, "Section"],
  [/\bRefs?\.(?=\s*\[?\d)/g, "Reference"],
  [/\bNo\.(?=\s*\d)/g, "Number"],
];

// [12], [3, 5], [3-7], [3–7, 9]
const NUMERIC_CITATION = /\s*\[\d+(?:\s*[,;–—-]\s*\d+)*\]/g;

// One author-year reference: "Smith, 2020", "Smith et al. 2020a",
// "Smith and Lee, 2019, 2021", optionally led by "e.g.," or "see".
const AUTHOR_YEAR =
  /^(?:e\.\s?g\.,?|see|cf\.)?\s*[A-Z][^;()]*?,?\s+(?:19|20)\d{2}[a-z]?(?:,\s*(?:19|20)\d{2}[a-z]?)*$/;

/**
 * Some PDFs (often ACM and older LaTeX fonts) have no Unicode mapping for
 * ligatures, so "fi", "ff", "fl", "ffi" and "ffl" come out as U+FFFF:
 * "\uFFFFrst", "e\uFFFFcient", "di\uFFFFerent". Guess which one from the
 * letters around it; "fi" is by far the most common.
 */
export function guessLigature(before: string, after: string): string {
  const pre = before.toLowerCase();
  const post = after.toLowerCase();
  // Diffie(-Hellman), affirm, suffix, affix
  if (pre.endsWith("di") && /^e($|[A-Z])/.test(after)) return "ffi";
  if (/^(a|su)$/.test(pre) && /^(rm|x)/.test(post)) return "ffi";
  // efficient, sufficient, office, official, difficult, efficacy, traffic
  if (/^(cien|cial|cult|ce|cer|cac)/.test(post)) return "ffi";
  if (pre.endsWith("tra") && post.startsWith("c")) return "ffi";
  // reflect, deflect, inflect (vs effect)
  if (post.startsWith("ect")) return /(re|de|in)$/.test(pre) ? "fl" : "ff";
  // flow, float, influence, flux, flight, conflict, flexible, flag, ...
  if (
    /^(ow|oat|uen|ux|ight|ict|exi|ag|ip|aw|uid|ash|at|oor|ood|ock|ush|ute|y$|ies|ier)/.test(
      post,
    )
  ) {
    return "fl";
  }
  // offline, shuffle, baffle, muffle
  if (
    /(shu|ba|mu|ru|ra|wa|sni)$/.test(pre) &&
    /^(e|ed|es|er|ing)$/.test(post)
  ) {
    return "ffl";
  }
  if (pre === "o" && /^ine/.test(post)) return "ffl";
  // different, effort, offer, afford, suffer, buffer, staff, stuff, offset
  const ffPrefix =
    /(di|su|bu|sta|stu|tra|cli|sti|sni|coe|cha|ga|pu|hu)$/.test(pre) ||
    /^(o|a|e)$/.test(pre);
  if (
    ffPrefix &&
    (/^[aeiou]/.test(post) || /^s(et|ide|hoot|pring)/.test(post) || !post)
  ) {
    return "ff";
  }
  return "fi";
}

/**
 * Replace U+FFFF inside words with a guessed ligature; elsewhere (next to
 * variable names in formulas) it stands for a glyph we can't recover.
 */
function repairLigatures(text: string): string {
  return text.replace(
    /([A-Za-z]*)\uFFFF([A-Za-z]*)/g,
    (match, before: string, after: string) =>
      /[a-z]{2}/.test(before + after)
        ? before + guessLigature(before, after) + after
        : before + after,
  );
}

export function cleanText(raw: string, opts: CleanOptions): string {
  let text = repairLigatures(raw)
    .replace(/\r\n?/g, "\n")
    .replace(/[\uFB00-\uFB06]/g, (c) => LIGATURES[c] ?? c)
    // Unmapped glyphs and private-use symbols can't be pronounced.
    .replace(/[\uFFFD\uFFFF\uE000-\uF8FF]/g, "")
    .replace(/\u00AD/g, "") // soft hyphen
    .replace(/[\u00A0\u2000-\u200B\u202F]/g, " ");

  // Exponents marked by collectParagraphs(): "2^k", "n^4".
  text = text.replace(/\^([A-Za-z0-9]+)/g, " to the power $1");

  // Words hyphenated across a line break: "algo-\nrithm" or "algo- rithm".
  text = text.replace(/([a-z])-\s*\n\s*([a-z])/g, "$1$2");
  text = text.replace(/([a-z])- ([a-z])/g, "$1$2");
  text = text.replace(/\s*\n\s*/g, " ");

  if (opts.stripCitations) {
    text = text.replace(NUMERIC_CITATION, "");
    text = text.replace(
      /\s*\(([^()]*\d{4}[a-z]?)\)/g,
      (match, inner: string) =>
        inner.split(";").every((part) => AUTHOR_YEAR.test(part.trim()))
          ? ""
          : match,
    );
  }

  for (const [pattern, replacement] of ABBREVIATIONS) {
    text = text.replace(pattern, replacement);
  }

  return text
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Split cleaned text into sentences, then cap each one at `maxChars`. */
export function splitSentences(
  text: string,
  maxChars = MAX_CHUNK_CHARS,
): string[] {
  const sentences = text
    // Break after . ! ? (optionally followed by a closing quote or bracket)
    // when the next sentence starts with a capital, digit, quote or bracket.
    .split(/(?<=[.!?]["'\u201D)\]]?)\s+(?=["'\u201C([]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => /[A-Za-z0-9]/.test(s));
  return sentences.flatMap((s) => capLength(s, maxChars));
}

function capLength(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];
  // Prefer clause boundaries, then fall back to plain spaces.
  for (const boundary of [/(?<=[;:])\s+/, /(?<=,)\s+/, /\s+/]) {
    const parts = sentence.split(boundary);
    if (parts.length < 2) continue;
    const chunks: string[] = [];
    let current = "";
    for (const part of parts) {
      const joined = current ? `${current} ${part}` : part;
      if (joined.length > maxChars && current) {
        chunks.push(current);
        current = part;
      } else {
        current = joined;
      }
    }
    if (current) chunks.push(current);
    if (chunks.every((c) => c.length <= maxChars)) return chunks;
    if (boundary.source === "\\s+") return chunks;
    return chunks.flatMap((c) => capLength(c, maxChars));
  }
  return [sentence];
}

/** Clean and split one text or several paragraphs into speakable chunks. */
export function prepareSpeech(
  raw: string | string[],
  opts: CleanOptions,
): string[] {
  const paragraphs = Array.isArray(raw) ? raw : [raw];
  const chunks = paragraphs.flatMap((p) => splitSentences(cleanText(p, opts)));
  return rampUp(chunks);
}

/**
 * Split the leading chunks so chunk i is at most
 * `first + growth * (characters in chunks before i)`, carrying what is cut
 * off over to the next chunk, until the limit reaches `maxChars`.
 */
export function rampUp(
  chunks: string[],
  { first, growth } = RAMP,
  maxChars = MAX_CHUNK_CHARS,
): string[] {
  const out: string[] = [];
  const queue = [...chunks];
  let before = 0;
  while (queue.length) {
    const limit = Math.floor(first + growth * before);
    if (limit >= maxChars) break;
    const chunk = queue.shift()!;
    if (chunk.length <= limit) {
      out.push(chunk);
      before += chunk.length;
      continue;
    }
    const lead = leadOf(chunk, limit);
    out.push(lead);
    before += lead.length;
    const rest = chunk.slice(lead.length).trim();
    if (rest) queue.unshift(rest);
  }
  return [...out, ...queue];
}

/**
 * The longest start of `text` that fits in `limit` characters, ending at a
 * clause boundary when that keeps most of the length, otherwise at a word.
 */
function leadOf(text: string, limit: number): string {
  let word = "";
  let clause = "";
  for (const match of text.matchAll(/\S+/g)) {
    const end = match.index! + match[0].length;
    if (end > limit) break;
    word = text.slice(0, end);
    if (/[,;:]$/.test(match[0])) clause = word;
  }
  if (clause.length >= 0.6 * word.length) return clause;
  return word || (text.match(/^\S+/)?.[0] ?? text);
}
