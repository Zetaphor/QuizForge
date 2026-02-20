import { describe, expect, it } from "vitest";
import {
  chooseQuestionCountFromSources,
  coerceStringArrayItems,
  finalQuizSchema,
  generateQuizIteratively
} from "../src/server/services/quiz-generator.js";

describe("generateQuizIteratively", () => {
  it("returns schema-valid quiz in mock mode", async () => {
    process.env.MOCK_LLM = "1";

    const result = await generateQuizIteratively({
      sources: [
        {
          origin: "markdown",
          title: "Sample",
          content: "# Topic\n\nImportant concept details."
        }
      ],
      topic: "Sample Topic",
      questionCount: 6
    });

    expect(() => finalQuizSchema.parse(result.quiz)).not.toThrow();
    expect(result.quiz.questions.length).toBeGreaterThanOrEqual(4);
  });

  it("coerces object arrays into string arrays", () => {
    const output = coerceStringArrayItems([
      { concept: "Data modeling" },
      { title: "Normalization" },
      { text: "Index selection" },
      "Query planning"
    ]);

    expect(output).toEqual(["Data modeling", "Normalization", "Index selection", "Query planning"]);
  });

  it("chooses higher question count for larger sources", () => {
    const small = chooseQuestionCountFromSources(
      [{ origin: "markdown", title: "s", content: "tiny content" }],
      { concepts: ["a", "b", "c"], misconceptions: ["m"], learningGoals: ["g"] }
    );
    const large = chooseQuestionCountFromSources(
      [{ origin: "markdown", title: "l", content: "x".repeat(30000) }],
      { concepts: ["a", "b", "c", "d", "e", "f"], misconceptions: ["m1", "m2", "m3"], learningGoals: ["g1", "g2"] }
    );

    expect(small).toBeGreaterThanOrEqual(4);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(20);
  });
});
