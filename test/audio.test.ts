import { assert } from "chai";
import { pauseAfter, trimSilence } from "../src/modules/audio";

describe("audio", function () {
  const rate = 1000;
  const clip = (lead: number, speech: number, tail: number) => {
    const pcm = new Float32Array(lead + speech + tail);
    pcm.fill(0.5, lead, lead + speech);
    return pcm;
  };

  it("trims padding down to the requested lead and tail", function () {
    const out = trimSilence(clip(350, 1000, 450), rate, {
      lead: 0.03,
      tail: 0.1,
    });
    assert.equal(out.length, 30 + 1000 + 100);
  });

  it("keeps short padding as it is", function () {
    const out = trimSilence(clip(10, 1000, 20), rate, {
      lead: 0.03,
      tail: 0.1,
    });
    assert.equal(out.length, 1030);
  });

  it("returns nothing for silence", function () {
    assert.equal(trimSilence(new Float32Array(500), rate).length, 0);
  });

  it("pauses longer after sentences than inside them", function () {
    assert.isAbove(pauseAfter("It works."), pauseAfter("It works,"));
    assert.isAbove(pauseAfter("It works,"), pauseAfter("It works"));
  });
});
