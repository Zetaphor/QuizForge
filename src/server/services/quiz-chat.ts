import { z } from "zod";
import { LlmJsonClient } from "./llm.js";

const chatReplySchema = z.object({
  reply: z.string()
});

type QuizQuestionContext = {
  id: string;
  prompt: string;
  type: string;
};

type QuizAnswerContext = {
  questionId: string;
  userAnswer: string;
  correctness: string;
  feedback: string | null;
  createdAt?: Date;
};

type QuizChatRequest = {
  quiz: {
    title: string;
    topic: string;
    summary?: string;
    questions: QuizQuestionContext[];
  };
  answers: QuizAnswerContext[];
  message: string;
  questionId?: string;
  questionIndex?: number;
};

function clip(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function buildQuestionHistory(questions: QuizQuestionContext[], answers: QuizAnswerContext[]): string {
  const latestByQuestion = new Map<string, QuizAnswerContext>();
  for (const answer of answers) {
    latestByQuestion.set(answer.questionId, answer);
  }

  return questions
    .map((question, index) => {
      const latest = latestByQuestion.get(question.id);
      if (!latest) {
        return `${index + 1}. [${question.type}] ${clip(question.prompt, 260)}\n   - Status: unanswered`;
      }

      return (
        `${index + 1}. [${question.type}] ${clip(question.prompt, 260)}\n` +
        `   - Your latest answer: ${clip(latest.userAnswer, 220)}\n` +
        `   - Result: ${latest.correctness}\n` +
        `   - Feedback: ${clip(latest.feedback ?? "N/A", 220)}`
      );
    })
    .join("\n");
}

export function buildQuizChatPrompt(input: QuizChatRequest): string {
  const currentQuestion =
    (input.questionId ? input.quiz.questions.find((question) => question.id === input.questionId) : null) ??
    (typeof input.questionIndex === "number" ? input.quiz.questions[input.questionIndex] : null) ??
    null;

  const currentQuestionBlock = currentQuestion
    ? `Current question: ${clip(currentQuestion.prompt, 300)}`
    : "Current question: unavailable";

  const questionHistory = buildQuestionHistory(input.quiz.questions, input.answers);

  return (
    `Quiz title: ${input.quiz.title}\n` +
    `Quiz topic: ${input.quiz.topic || "General"}\n` +
    `Quiz summary: ${clip(input.quiz.summary ?? "N/A", 300)}\n` +
    `${currentQuestionBlock}\n` +
    `Question and answer history:\n${questionHistory}\n\n` +
    `Learner message: ${input.message}\n` +
    `Instructions: respond in plain text, reference only quiz context above, and keep the answer concise and supportive.`
  );
}

export async function generateQuizChatReply(input: QuizChatRequest): Promise<{ reply: string }> {
  const llm = new LlmJsonClient();
  const prompt = buildQuizChatPrompt(input);
  const reply = await llm.completeJson(
    [
      {
        role: "system",
        content: "You are a quiz coach helping learners review current and previous questions. Return JSON only."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    chatReplySchema,
    () => {
      const answeredCount = new Set(input.answers.map((answer) => answer.questionId)).size;
      return {
        reply:
          `Let's review this together. So far you've answered ${answeredCount} ` +
          `of ${input.quiz.questions.length} questions. Focus on the core concept in the current prompt and compare it with your earlier feedback.`
      };
    }
  );

  return { reply: reply.reply.trim() };
}
