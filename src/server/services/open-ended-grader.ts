import { z } from "zod";
import { LlmJsonClient } from "./llm.js";

const gradeSchema = z.object({
  correctness: z.enum(["correct", "partially_correct", "incorrect"]),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
  followup: z.string()
});

export type OpenEndedGrade = z.infer<typeof gradeSchema>;

export async function gradeOpenEndedAnswer(input: {
  prompt: string;
  expectedAnswer?: string | null;
  rubric?: string | null;
  userAnswer: string;
}): Promise<OpenEndedGrade> {
  const llm = new LlmJsonClient();

  return llm.completeJson(
    [
      {
        role: "system",
        content: "You are a strict but supportive quiz grader. Return JSON only."
      },
      {
        role: "user",
        content:
          `Grade the learner answer.\n` +
          `Prompt: ${input.prompt}\n` +
          `ExpectedAnswer: ${input.expectedAnswer ?? "N/A"}\n` +
          `Rubric: ${input.rubric ?? "N/A"}\n` +
          `LearnerAnswer: ${input.userAnswer}\n` +
          `Return correctness/confidence/explanation/followup.`
      }
    ],
    gradeSchema,
    () => {
      const normalizedExpected = (input.expectedAnswer ?? "").toLowerCase();
      const normalizedUser = input.userAnswer.toLowerCase();
      const match = normalizedExpected && normalizedUser.includes(normalizedExpected.slice(0, 12));
      return {
        correctness: match ? "correct" : "partially_correct",
        confidence: match ? 0.8 : 0.55,
        explanation: match
          ? "Your answer aligns with the expected concept."
          : "Your answer is on the right track but misses key expected details.",
        followup: "Revisit the source and include one concrete example in your next attempt."
      };
    }
  );
}
