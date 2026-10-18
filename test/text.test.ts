import { assert } from "chai";
import {
  cleanText,
  RAMP,
  rampUp,
  MAX_CHUNK_CHARS,
  prepareSpeech,
  splitSentences,
} from "../src/modules/text";

const strip = { stripCitations: true };
const keep = { stripCitations: false };

describe("text", function () {
  describe("cleanText", function () {
    it("joins words hyphenated across lines", function () {
      assert.equal(cleanText("a new algo-\nrithm", keep), "a new algorithm");
      assert.equal(cleanText("a new algo- rithm", keep), "a new algorithm");
    });

    it("keeps real hyphens", function () {
      assert.equal(cleanText("state-of-the-art", keep), "state-of-the-art");
    });

    it("expands ligatures and joins lines", function () {
      assert.equal(cleanText("eﬃcient\nmodels", keep), "efficient models");
    });

    it("removes numeric citations", function () {
      assert.equal(
        cleanText("as shown in [12, 15] and [3–7].", strip),
        "as shown in and.",
      );
    });

    it("removes author-year citations but keeps other parentheses", function () {
      assert.equal(
        cleanText(
          "Transformers (Vaswani et al., 2017; Devlin et al. 2019) work.",
          strip,
        ),
        "Transformers work.",
      );
      assert.equal(
        cleanText("We use data (collected in 2020) here.", strip),
        "We use data (collected in 2020) here.",
      );
    });

    it("keeps citations when disabled", function () {
      assert.include(cleanText("as shown in [12].", keep), "[12]");
    });

    it("repairs ligatures that PDFs extracted as U+FFFF", function () {
      const broken = (w: string) => w.replace("_", "\uFFFF");
      const words = [
        "_rst",
        "e_cient",
        "di_erent",
        "satis_es",
        "de_nition",
        "veri_es",
        "_nal",
        "speci_c",
        "re_ect",
        "e_ect",
        "work_ow",
        "con_ict",
        "in_uence",
        "o_ine",
        "e_ort",
        "a_rmative",
        "su_cient",
        "Di_e",
      ];
      const expected =
        "first efficient different satisfies definition verifies final specific reflect effect workflow conflict influence offline effort affirmative sufficient Diffie";
      assert.equal(cleanText(words.map(broken).join(" "), keep), expected);
    });

    it("drops unrecoverable glyphs next to symbols", function () {
      assert.equal(
        cleanText("The L\uFFFF and \uFFFFC values\uE000.", keep),
        "The L and C values.",
      );
    });

    it("reads exponents", function () {
      assert.equal(
        cleanText("mod 2^k and O(n^4)", keep),
        "mod 2 to the power k and O(n to the power 4)",
      );
    });

    it("expands paper abbreviations", function () {
      assert.equal(
        cleanText("See Fig. 3 and Eq. (2), e.g. accuracy, i.e. F1.", keep),
        "See Figure 3 and Equation (2), for example, accuracy, that is, F1.",
      );
    });
  });

  describe("splitSentences", function () {
    it("splits on sentence boundaries only", function () {
      assert.deepEqual(
        splitSentences(
          cleanText(
            "Smith et al. found it. The value is 3.5 here! Done.",
            keep,
          ),
        ),
        ["Smith et al found it.", "The value is 3.5 here!", "Done."],
      );
    });

    it("caps very long sentences", function () {
      const long = "This clause keeps going, ".repeat(30) + "end.";
      const chunks = splitSentences(long);
      assert.isAbove(chunks.length, 1);
      for (const chunk of chunks)
        assert.isAtMost(chunk.length, MAX_CHUNK_CHARS);
      assert.equal(chunks.join(" "), long);
    });

    it("drops fragments with no letters or digits", function () {
      assert.deepEqual(splitSentences("Hello. ... !"), ["Hello. ... !"]);
      assert.deepEqual(splitSentences("  "), []);
    });
  });

  describe("prepareSpeech", function () {
    it("ramps chunk sizes up from a short first chunk", function () {
      const long =
        "Large language models have shown remarkable abilities, yet their reasoning remains brittle under distribution shift.";
      const chunks = prepareSpeech([long, "Next paragraph."], keep);
      let before = 0;
      for (const chunk of chunks) {
        const limit = Math.floor(RAMP.first + RAMP.growth * before);
        if (limit >= MAX_CHUNK_CHARS) break;
        assert.isAtMost(chunk.length, limit, chunk);
        before += chunk.length;
      }
      assert.equal(chunks.join(" "), `${long} Next paragraph.`);
    });

    it("counts short chunks toward the ramp", function () {
      // A short heading first: the sentence after it still gets split.
      const chunks = rampUp([
        "2 Method.",
        "We select a sentence and start reading from that point.",
      ]);
      assert.equal(chunks[0], "2 Method.");
      assert.isAtMost(
        chunks[1].length,
        Math.floor(RAMP.first + RAMP.growth * 9),
      );
    });

    it("leaves chunks alone once the ramp reaches full size", function () {
      const long = "word ".repeat(40).trim() + ".";
      const chunks = rampUp(["x".repeat(200), long], { first: 300, growth: 1 });
      assert.deepEqual(chunks, ["x".repeat(200), long]);
    });
  });
});
