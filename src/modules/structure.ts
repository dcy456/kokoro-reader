/**
 * Read Zotero's structured document text (SDT) -- the reading-order model of
 * a document that Zotero's own Read Aloud uses -- as plain paragraphs.
 * Pure functions over the JSON structure, so they are easy to test.
 *
 * Shape (as of Zotero 10): `content` is a tree of blocks
 * (`{ type, content, flowClass?, nextPart?, prevPart?, anchor? }`) whose leaf
 * blocks hold text nodes (`{ text }`). Running headers and page numbers have
 * `flowClass: "excluded"`. A paragraph split across pages or columns is a
 * chain of blocks linked by `nextPart` refs. A position is
 * `{ start: ref, end: ref }`, a ref being a path of indexes into `content`
 * followed by the text node index and character offset.
 */

export type Ref = number[];

export interface SDTNode {
  type?: string;
  text?: string;
  style?: { sup?: boolean; sub?: boolean };
  refs?: unknown[];
  content?: SDTNode[];
  flowClass?: string;
  nextPart?: Ref;
  prevPart?: Ref;
  anchor?: { pageRects?: number[][] };
}

export interface Paragraph {
  type: string;
  text: string;
  /** Page index of the first part, when the document has pages. */
  pageIndex?: number;
  /** Each block of the chain and where its text starts in `text`. */
  parts: Array<{ ref: Ref; offset: number; nodeOffsets: number[] }>;
}

const SKIPPED_TYPES = new Set(["table", "figure", "image", "formula", "code"]);

const REFERENCES_HEADING =
  /^\s*(?:[\dIVX]+\.?\s+)?(?:references|bibliography|works cited|literature cited|reference list)\s*$/i;

export function isReferencesHeading(paragraph: Paragraph): boolean {
  return REFERENCES_HEADING.test(paragraph.text);
}

function isTextNode(node: SDTNode | undefined): boolean {
  return typeof node?.text === "string";
}

function isLeafBlock(node: SDTNode): boolean {
  if (isTextNode(node)) return false;
  if (!Array.isArray(node.content) || node.content.length === 0) return true;
  return node.content.every(isTextNode);
}

function nodeAt(content: SDTNode[], ref: Ref): SDTNode | undefined {
  let nodes: SDTNode[] | undefined = content;
  let node: SDTNode | undefined;
  for (const index of ref) {
    node = nodes?.[index];
    nodes = node?.content;
  }
  return node;
}

/**
 * A text node as it should be read. Superscripts are either footnote markers
 * ("protocol\u00B9", or a digit opening a footnote), which are dropped like
 * Zotero's own Read Aloud does, or exponents ("O(n\u2074)", "2\u1D4F"),
 * which become "^" for cleanText() to read as "to the power".
 */
function spokenText(node: SDTNode, before: string): string {
  const text = node.text ?? "";
  if (!node.style?.sup) return text;
  const isMarker =
    !!node.refs?.length ||
    /^[*\u2020\u2021\u00A7\u2217]+$/.test(text.trim()) ||
    !before.trim() ||
    /[A-Za-z]{3}[.,;:!?)\]]?\s*$/.test(before) ||
    /\s$/.test(before);
  return isMarker ? "" : `^${text}`;
}

/** Every readable paragraph in document order, with split parts joined. */
export function collectParagraphs(content: SDTNode[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const emitted = new Set<string>();

  const emit = (ref: Ref, block: SDTNode) => {
    let text = "";
    const parts: Paragraph["parts"] = [];
    let currentRef: Ref | undefined = ref;
    let current: SDTNode | undefined = block;
    while (currentRef && current && !emitted.has(currentRef.join(","))) {
      if (current.flowClass === "excluded") break;
      emitted.add(currentRef.join(","));
      // A line break between parts lets cleanText() rejoin hyphenated words.
      if (parts.length) text += "\n";
      const nodeOffsets: number[] = [];
      const offset = text.length;
      for (const node of current.content ?? []) {
        nodeOffsets.push(text.length - offset);
        text += spokenText(node, text.slice(offset));
      }
      parts.push({ ref: currentRef, offset, nodeOffsets });
      currentRef = current.nextPart;
      current = currentRef ? nodeAt(content, currentRef) : undefined;
    }
    if (text.trim()) {
      paragraphs.push({
        type: block.type ?? "paragraph",
        text,
        pageIndex: block.anchor?.pageRects?.[0]?.[0],
        parts,
      });
    }
  };

  const walk = (nodes: SDTNode[], path: Ref) => {
    nodes.forEach((node, i) => {
      const ref = [...path, i];
      if (!node || isTextNode(node) || node.flowClass === "excluded") return;
      if (node.type && SKIPPED_TYPES.has(node.type)) return;
      if (isLeafBlock(node)) {
        // Continuation parts are read as part of their chain's first block.
        if (!node.prevPart && !emitted.has(ref.join(","))) emit(ref, node);
      } else if (node.content) {
        walk(node.content, ref);
      }
    });
  };
  walk(content, []);
  return paragraphs;
}

/** Locate a position (`start` ref) as a paragraph index and text offset. */
export function locate(
  paragraphs: Paragraph[],
  start: Ref,
): { index: number; offset: number } | null {
  for (let index = 0; index < paragraphs.length; index++) {
    for (const part of paragraphs[index].parts) {
      const { ref } = part;
      if (ref.every((value, i) => start[i] === value)) {
        const nodeIndex = start[ref.length] ?? 0;
        const charOffset = start[ref.length + 1] ?? 0;
        const nodeOffset =
          part.nodeOffsets[Math.min(nodeIndex, part.nodeOffsets.length - 1)] ??
          0;
        return { index, offset: part.offset + nodeOffset + charOffset };
      }
    }
  }
  // Positions in skipped blocks (headers, figures): continue from the next
  // paragraph in document order.
  for (let index = 0; index < paragraphs.length; index++) {
    if (compareRefs(paragraphs[index].parts[0].ref, start) >= 0) {
      return { index, offset: 0 };
    }
  }
  return null;
}

export function compareRefs(a: Ref, b: Ref): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Back up from `offset` to the start of the sentence that contains it. */
export function sentenceStart(text: string, offset: number): number {
  let start = 0;
  for (const match of text.matchAll(/[.!?]["'”)\]]?\s+/g)) {
    const end = match.index! + match[0].length;
    if (end > offset) break;
    start = end;
  }
  return start;
}

export interface ReadFromOptions {
  /** Stop before a "References" (or "Bibliography") heading. */
  stopAtReferences: boolean;
}

/**
 * Text to read from a starting point to the end of the document: one string
 * per paragraph, the first one starting at the sentence that contains the
 * starting point. Headings get a full stop so the voice pauses after them.
 */
export function textFrom(
  paragraphs: Paragraph[],
  start: { index: number; offset: number },
  opts: ReadFromOptions,
): string[] {
  const texts: string[] = [];
  for (let i = start.index; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    if (opts.stopAtReferences && isReferencesHeading(paragraph)) break;
    let text = paragraph.text;
    if (i === start.index && start.offset > 0) {
      text = text.slice(sentenceStart(text, start.offset));
    }
    text = text.trim();
    if (!text) continue;
    if (!/[.!?:;]["'”)\]]?$/.test(text)) text += ".";
    texts.push(text);
  }
  return texts;
}

/** First paragraph on or after `pageIndex` (for "read from this page"). */
export function firstOnPage(paragraphs: Paragraph[], pageIndex: number) {
  const index = paragraphs.findIndex(
    (p) => p.pageIndex !== undefined && p.pageIndex >= pageIndex,
  );
  return index === -1 ? null : { index, offset: 0 };
}
