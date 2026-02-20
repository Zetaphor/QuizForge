import { z } from "zod";
import type { NormalizedSource } from "./ingestion.js";
import { LlmJsonClient } from "./llm.js";

function pickTextFromObject(value: Record<string, unknown>): string | null {
  const preferredKeys = ["name", "title", "label", "concept", "text", "description", "summary"];
  for (const key of preferredKeys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function coerceToText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const direct = pickTextFromObject(value as Record<string, unknown>);
    if (direct) return direct;
    const json = JSON.stringify(value);
    return json === "{}" ? null : json;
  }
  return null;
}

export function coerceStringArrayItems(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => coerceToText(item)).filter((item): item is string => Boolean(item));
}

function flexibleStringArraySchema(minItems: number) {
  return z.preprocess((input) => coerceStringArrayItems(input), z.array(z.string()).min(minItems));
}

const coverageSchema = z.object({
  topic: z.string(),
  learningGoals: flexibleStringArraySchema(1),
  concepts: flexibleStringArraySchema(3),
  misconceptions: flexibleStringArraySchema(1)
});

const questionDraftSchema = z.object({
  title: z.string(),
  questions: z
    .array(
      z.object({
        type: z.enum(["multiple_choice", "open_ended"]),
        prompt: z.string(),
        choices: z.array(z.string()).optional(),
        correctChoiceIndex: z.number().int().optional(),
        expectedAnswer: z.string().optional(),
        rubric: z.string().optional()
      })
    )
    .min(1)
});

const critiqueSchema = z.object({
  issues: z.array(z.string()),
  strengths: z.array(z.string()),
  revisions: z.array(z.string())
});

export const finalQuizSchema = z.object({
  title: z.string(),
  topic: z.string(),
  summary: z.string(),
  questions: z
    .array(
      z.object({
        type: z.enum(["multiple_choice", "open_ended"]),
        prompt: z.string(),
        choices: z.array(z.string()).optional(),
        correctChoiceIndex: z.number().int().optional(),
        expectedAnswer: z.string().optional(),
        rubric: z.string().optional(),
        explanation: z.string().optional()
      })
    )
    .min(1)
});

export type FinalQuiz = z.infer<typeof finalQuizSchema>;

type GenerateInput = {
  sources: NormalizedSource[];
  title?: string;
  description?: string;
  topic?: string;
  autoMetadata?: boolean;
  questionCount?: number;
  focusPrompts?: string[];
};

const metadataSchema = z.object({
  title: z.string(),
  topic: z.string(),
  description: z.string()
});

function buildSourcePacket(sources: NormalizedSource[]): string {
  return sources
    .map((source, index) => {
      const clipped = source.content.length > 7000 ? `${source.content.slice(0, 7000)}\n...[truncated]` : source.content;
      return `Source ${index + 1}\nOrigin: ${source.origin}\nTitle: ${source.title}\nContent:\n${clipped}`;
    })
    .join("\n\n---\n\n");
}

function fallbackQuiz(topic: string, title: string, count: number): FinalQuiz {
  const safeCount = Math.max(4, count);
  const questions = Array.from({ length: safeCount }).map((_, idx) => {
    const isMcq = idx % 2 === 0;
    if (isMcq) {
      return {
        type: "multiple_choice" as const,
        prompt: `Which statement best reflects concept #${idx + 1} in ${topic}?`,
        choices: ["Option A", "Option B", "Option C", "Option D"],
        correctChoiceIndex: 0,
        explanation: "Option A is currently the baseline answer in fallback mode."
      };
    }
    return {
      type: "open_ended" as const,
      prompt: `Explain concept #${idx + 1} from ${topic} in your own words.`,
      expectedAnswer: "A complete answer should explain the concept and give one concrete example.",
      rubric: "Award full credit for conceptual correctness + example.",
      explanation: "Focus on conceptual clarity and example quality."
    };
  });

  return {
    title,
    topic,
    summary: "Fallback quiz generated when the LLM is not available.",
    questions
  };
}

function clampQuestionCount(value: number): number {
  return Math.max(4, Math.min(20, Math.round(value)));
}

export function chooseQuestionCountFromSources(
  sources: NormalizedSource[],
  coverage: { concepts: string[]; misconceptions: string[]; learningGoals: string[] }
): number {
  const totalChars = sources.reduce((sum, source) => sum + source.content.length, 0);
  let baseCount = 6;

  if (totalChars >= 25000) baseCount = 14;
  else if (totalChars >= 12000) baseCount = 12;
  else if (totalChars >= 6000) baseCount = 10;
  else if (totalChars >= 2500) baseCount = 8;

  const complexitySignals =
    coverage.concepts.length + coverage.misconceptions.length + Math.ceil(coverage.learningGoals.length / 2);
  const complexityBoost = Math.min(4, Math.max(0, Math.ceil(complexitySignals / 5) - 1));

  return clampQuestionCount(baseCount + complexityBoost);
}

export async function generateQuizIteratively(input: GenerateInput): Promise<{
  quiz: FinalQuiz;
  metadata: Record<string, unknown>;
}> {
  const startedAt = Date.now();
  const logStep = (message: string) => {
    const elapsedMs = Date.now() - startedAt;
    console.log(`[QuizGen][${elapsedMs}ms] ${message}`);
  };

  const providedQuestionCount =
    typeof input.questionCount === "number" && Number.isFinite(input.questionCount)
      ? clampQuestionCount(input.questionCount)
      : null;
  const autoMetadata = Boolean(input.autoMetadata);
  const userTitle = input.title?.trim();
  const userTopic = input.topic?.trim();
  const userDescription = input.description?.trim();
  const sourcePacket = buildSourcePacket(input.sources);
  const focusPrompts = coerceStringArrayItems(input.focusPrompts).slice(0, 12);
  const focusGuidance = focusPrompts.length
    ? `\nPriority focus areas (questions the learner has struggled with):\n${focusPrompts.map((prompt) => `- ${prompt}`).join("\n")}`
    : "";
  const llm = new LlmJsonClient();
  logStep("Starting metadata generation pass.");

  const generatedMetadata = await llm.completeJson(
    [
      {
        role: "system",
        content: "Generate concise quiz metadata from source material. Return JSON only."
      },
      {
        role: "user",
        content:
          "From these sources, produce a concise quiz title, topic, and description.\n" +
          "Title should be <= 10 words. Description should be 1-2 sentences.\n\n" +
          sourcePacket +
          focusGuidance
      }
    ],
    metadataSchema,
    () => ({
      title: "Self-Learning Quiz",
      topic: "Self-Learning",
      description: "A mixed quiz generated from your uploaded sources."
    })
  );

  const resolvedTopic = userTopic || (autoMetadata ? generatedMetadata.topic : "") || "Self-Learning Quiz";
  const resolvedTitle = userTitle || (autoMetadata ? generatedMetadata.title : "") || `${resolvedTopic} Quiz`;
  const resolvedDescription =
    userDescription || (autoMetadata ? generatedMetadata.description : "") || "A mixed quiz generated from the source content.";
  logStep("Metadata pass complete.");

  logStep("Starting coverage analysis pass.");
  const coverage = await llm.completeJson(
    [
      {
        role: "system",
        content: "You design pedagogically sound quizzes. Return JSON only."
      },
      {
        role: "user",
        content:
          `Analyze the sources and extract a study blueprint.\n` +
          `Need: topic, learningGoals, concepts, misconceptions.\n\n${sourcePacket}${focusGuidance}`
      }
    ],
    coverageSchema,
    () => ({
      topic: resolvedTopic,
      learningGoals: ["Understand the core topic"],
      concepts: ["Core idea", "Key workflow", "Common pitfall"],
      misconceptions: ["Confusing implementation details with concepts"]
    })
  );
  logStep("Coverage analysis pass complete.");

  const coverageForSizing = {
    concepts: coerceStringArrayItems(coverage.concepts as unknown),
    misconceptions: coerceStringArrayItems(coverage.misconceptions as unknown),
    learningGoals: coerceStringArrayItems(coverage.learningGoals as unknown)
  };
  const resolvedQuestionCount =
    providedQuestionCount ?? chooseQuestionCountFromSources(input.sources, coverageForSizing);
  logStep(
    providedQuestionCount == null
      ? `Auto-selected question count: ${resolvedQuestionCount}.`
      : `Using user-selected question count: ${resolvedQuestionCount}.`
  );

  logStep("Starting question draft pass.");
  const draft = await llm.completeJson(
    [
      {
        role: "system",
        content: "Draft mixed question quizzes and return JSON only."
      },
      {
        role: "user",
        content:
          `Create ${resolvedQuestionCount} questions from this blueprint.\n` +
          `Bias question selection toward the learner's weak areas when provided.\n` +
          `Must mix multiple_choice and open_ended.\n` +
          `Blueprint: ${JSON.stringify(coverage)}${focusGuidance}`
      }
    ],
    questionDraftSchema,
    () => fallbackQuiz(coverage.topic || resolvedTopic, resolvedTitle, resolvedQuestionCount)
  );
  logStep("Question draft pass complete.");

  logStep("Starting critique pass.");
  const critique = await llm.completeJson(
    [
      {
        role: "system",
        content: "Critique draft quiz quality. Return JSON only."
      },
      {
        role: "user",
        content:
          `Critique this draft for coverage, difficulty, and ambiguity.\n` +
          `Return strengths/issues/revisions.\n` +
          `Draft: ${JSON.stringify(draft)}\n` +
          `Blueprint: ${JSON.stringify(coverage)}${focusGuidance}`
      }
    ],
    critiqueSchema,
    () => ({
      issues: [],
      strengths: ["Covers major concepts"],
      revisions: ["Increase specificity in open-ended prompts"]
    })
  );
  logStep("Critique pass complete.");

  logStep("Starting final revision pass.");
  const finalQuiz = await llm.completeJson(
    [
      {
        role: "system",
        content: "Revise and finalize the quiz. Return JSON only."
      },
      {
        role: "user",
        content:
          `Produce final quiz JSON with title/topic/summary/questions.\n` +
          `Apply revisions: ${JSON.stringify(critique.revisions)}\n` +
          `Question count target: ${resolvedQuestionCount}\n` +
          `Draft: ${JSON.stringify(draft)}`
      }
    ],
    finalQuizSchema,
    () => {
      const fallback = fallbackQuiz(
        coverage.topic || resolvedTopic,
        draft.title || resolvedTitle,
        resolvedQuestionCount
      );
      return {
        ...fallback,
        topic: coverage.topic || resolvedTopic
      };
    }
  );
  logStep("Final revision pass complete.");

  const quiz: FinalQuiz = {
    ...finalQuiz,
    title: resolvedTitle,
    topic: resolvedTopic,
    summary: resolvedDescription
  };

  return {
    quiz,
    metadata: {
      resolvedMetadata: {
        title: resolvedTitle,
        topic: resolvedTopic,
        description: resolvedDescription,
        autoMetadata,
        questionCount: resolvedQuestionCount,
        autoQuestionCount: providedQuestionCount == null,
        focusedTroublePrompts: focusPrompts
      },
      generatedMetadata,
      coverage,
      critique,
      generationMode: process.env.MOCK_LLM === "1" ? "mock" : "live"
    }
  };
}
