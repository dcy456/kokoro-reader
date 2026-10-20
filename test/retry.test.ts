import { assert } from "chai";
import { retryAttempts } from "../src/worker/retry";

describe("retryAttempts", function () {
  it("tries a slightly faster speed first, keeping the words", function () {
    const [first] = retryAttempts("Theorem 1.", 1);
    assert.deepEqual(first, { text: "Theorem 1.", speed: 1.05 });
  });

  it("varies the final punctuation", function () {
    const texts = retryAttempts("Using ZK proofs,", 1).map((a) => a.text);
    assert.include(texts, "Using ZK proofs");
    assert.include(texts, "Using ZK proofs.");
  });

  it("never repeats the original attempt or an empty text", function () {
    for (const text of ["Done.", "x", "..."]) {
      for (const a of retryAttempts(text, 1)) {
        assert.isNotEmpty(a.text.trim());
        assert.isFalse(a.text === text && a.speed === 1);
      }
    }
  });
});
