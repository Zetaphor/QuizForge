import { describe, expect, it } from "vitest";
import { scoreMultipleChoice } from "../src/server/services/scoring.js";

describe("scoreMultipleChoice", () => {
  it("scores correct answer", () => {
    expect(scoreMultipleChoice(2, "2")).toEqual({ correctness: "correct", score: 1 });
  });

  it("scores incorrect answer", () => {
    expect(scoreMultipleChoice(2, "1")).toEqual({ correctness: "incorrect", score: 0 });
  });
});
