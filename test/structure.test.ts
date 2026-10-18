import { assert } from "chai";
import {
  collectParagraphs,
  firstOnPage,
  locate,
  sentenceStart,
  textFrom,
  type SDTNode,
} from "../src/modules/structure";

const page = (pageIndex: number) => ({
  pageRects: [[pageIndex, 72, 600, 400, 620]],
});
const para = (text: string, pageIndex: number, extra: Partial<SDTNode> = {}) =>
  ({
    type: "paragraph",
    anchor: page(pageIndex),
    content: [{ text }],
    ...extra,
  }) as SDTNode;

// Shaped like Zotero's SDT for test/fixtures/sample-paper.pdf, plus a
// paragraph split across the page break (blocks 4 and 7).
const CONTENT: SDTNode[] = [
  para("Running Header", 0, { flowClass: "excluded" }),
  { type: "heading", anchor: page(0), content: [{ text: "1 Introduction" }] },
  para("First sentence here. Second sentence here.", 0),
  { type: "figure", anchor: page(0), content: [{ text: "Figure text" }] },
  {
    type: "paragraph",
    anchor: page(0),
    content: [
      { text: "This paragraph is " },
      { text: "split across the page bre-" },
    ],
    nextPart: [7],
  },
  para("1", 0, { flowClass: "excluded" }),
  para("Running Header", 1, { flowClass: "excluded" }),
  {
    type: "paragraph",
    anchor: page(1),
    content: [{ text: "ak and continues." }],
    prevPart: [4],
  },
  { type: "heading", anchor: page(1), content: [{ text: "References" }] },
  {
    type: "list",
    anchor: page(1),
    content: [
      { type: "listitem", content: [{ text: "[1] A. Author. 2020." }] },
      { type: "listitem", content: [{ text: "[2] B. Author. 2021." }] },
    ],
  },
];

describe("structure", function () {
  let paragraphs: ReturnType<typeof collectParagraphs>;

  before(function () {
    paragraphs = collectParagraphs(CONTENT);
  });

  it("collects readable paragraphs in order, skipping excluded blocks and figures", function () {
    assert.deepEqual(
      paragraphs.map((p) => p.text),
      [
        "1 Introduction",
        "First sentence here. Second sentence here.",
        "This paragraph is split across the page bre-\nak and continues.",
        "References",
        "[1] A. Author. 2020.",
        "[2] B. Author. 2021.",
      ],
    );
    assert.equal(paragraphs[2].pageIndex, 0);
  });

  it("locates a position inside a text node", function () {
    // Block 2, node 0, offset 25 = inside "Second sentence here."
    assert.deepEqual(locate(paragraphs, [2, 0, 25]), { index: 1, offset: 25 });
  });

  it("locates a position in a later node and in a continuation part", function () {
    assert.deepEqual(locate(paragraphs, [4, 1, 6]), {
      index: 2,
      offset: "This paragraph is ".length + 6,
    });
    const inPart = locate(paragraphs, [7, 0, 3])!;
    assert.equal(inPart.index, 2);
    assert.equal(paragraphs[2].text.slice(inPart.offset), "and continues.");
  });

  it("continues from the next paragraph for positions in skipped blocks", function () {
    assert.deepEqual(locate(paragraphs, [6, 0, 0]), { index: 3, offset: 0 });
  });

  it("finds the start of the sentence around an offset", function () {
    const text = "One. Two three. Four.";
    assert.equal(sentenceStart(text, 0), 0);
    assert.equal(sentenceStart(text, 7), 5);
    assert.equal(sentenceStart(text, 5), 5);
    assert.equal(sentenceStart(text, 18), 16);
  });

  it("reads from a sentence to the References heading", function () {
    const start = locate(paragraphs, [2, 0, 25])!;
    assert.deepEqual(textFrom(paragraphs, start, { stopAtReferences: true }), [
      "Second sentence here.",
      "This paragraph is split across the page bre-\nak and continues.",
    ]);
  });

  it("reads references too when asked, and ends headings with a full stop", function () {
    const texts = textFrom(
      paragraphs,
      { index: 0, offset: 0 },
      { stopAtReferences: false },
    );
    assert.equal(texts[0], "1 Introduction.");
    assert.include(texts, "[2] B. Author. 2021.");
  });

  it("drops footnote markers and marks exponents", function () {
    const sup = (text: string, refs?: unknown[]) => ({
      text,
      style: { sup: true },
      refs,
    });
    const [p] = collectParagraphs([
      {
        type: "paragraph",
        content: [
          sup("2"),
          { text: "So the agreement protocol" },
          sup("1", [{}]),
          { text: " runs in O(n" },
          sup("4"),
          { text: ") words mod 2" },
          sup("k"),
          { text: ", by Cramer" },
          sup("\u2020"),
          { text: "." },
        ],
      },
    ]);
    assert.equal(
      p.text,
      "So the agreement protocol runs in O(n^4) words mod 2^k, by Cramer.",
    );
  });

  it("starts from the first paragraph on a page", function () {
    assert.deepEqual(firstOnPage(paragraphs, 1), { index: 3, offset: 0 });
    assert.isNull(firstOnPage(paragraphs, 5));
  });
});
