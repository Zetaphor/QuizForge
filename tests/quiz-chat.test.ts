import { describe, expect, it } from "vitest";
import { buildQuizChatPrompt, generateQuizChatReply } from "../src/server/services/quiz-chat.js";

describe("quiz chat service", () => {
  it("builds prompt with question and answer history", () => {
    const prompt = buildQuizChatPrompt({
      quiz: {
        title: "Data Systems Quiz",
        topic: "Data systems",
        summary: "Foundations review",
        questions: [
          { id: "q1", type: "multiple_choice", prompt: "What does ACID stand for?" },
          { id: "q2", type: "open_ended", prompt: "Explain eventual consistency." }
        ]
      },
      answers: [
        {
          questionId: "q1",
          userAnswer: "Atomicity, Consistency, Isolation, Durability",
          correctness: "correct",
          feedback: "Correct."
        }
      ],
      message: "Can you compare these concepts?",
      questionId: "q2",
      questionIndex: 1
    });

    expect(prompt).toContain("Quiz title: Data Systems Quiz");
    expect(prompt).toContain("Current question: Explain eventual consistency.");
    expect(prompt).toContain("Status: unanswered");
    expect(prompt).toContain("Your latest answer: Atomicity, Consistency, Isolation, Durability");
    expect(prompt).toContain("Learner message: Can you compare these concepts?");
    expect(prompt).toContain("Prioritize understanding over speed");
    expect(prompt).toContain("Do not provide a full worked solution unless the learner explicitly asks");
  });

  it("returns fallback reply in mock mode", async () => {
    process.env.MOCK_LLM = "1";

    const response = await generateQuizChatReply({
      quiz: {
        title: "Mock Quiz",
        topic: "Testing",
        summary: "Mock summary",
        questions: [{ id: "q1", type: "open_ended", prompt: "What is a deterministic fallback?" }]
      },
      answers: [],
      message: "Help me with this question",
      questionId: "q1",
      questionIndex: 0
    });

    expect(typeof response.reply).toBe("string");
    expect(response.reply.length).toBeGreaterThan(0);
    expect(response.reply).toContain("So far you've answered 0 of 1 questions");
  });
});
