import { PrismaClient } from "@prisma/client";

export type AnalyticsRange = "1d" | "7d" | "30d" | "90d" | "all";

export type AnalyticsFilters = {
  range: AnalyticsRange;
  quizId?: string;
  fromDate?: Date;
};

type AttemptWithRelations = {
  id: string;
  quizId: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  scorePercent: number | null;
  quiz: { id: string; title: string; topic: string | null };
  answers: Array<{
    id: string;
    score: number | null;
    question: { id: string; type: string; prompt: string };
  }>;
};

type QuizSummary = { id: string; title: string; topic: string | null; createdAt: Date };

export type TroubleQuestionCandidate = {
  questionId: string;
  quizId: string;
  prompt: string;
  type: string;
  choicesJson: string | null;
  expectedAnswer: string | null;
  rubricJson: string | null;
  metadataJson: string | null;
  missCount: number;
  lastMissedAt: Date;
};

function clampRange(value: string): AnalyticsRange {
  if (value === "1d" || value === "7d" || value === "30d" || value === "90d" || value === "all") {
    return value;
  }
  return "30d";
}

export function parseAnalyticsFilters(query: { range?: string; quizId?: string }): AnalyticsFilters {
  const range = clampRange(query.range ?? "30d");
  const quizId = query.quizId?.trim() || undefined;
  if (range === "all") {
    return { range, quizId };
  }

  const days = range === "1d" ? 1 : range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);
  return { range, quizId, fromDate };
}

function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((acc, val) => acc + val, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildAttemptsSeries(attempts: AttemptWithRelations[]) {
  const grouped = new Map<string, { attempts: number; scores: number[] }>();
  for (const attempt of attempts) {
    const key = toDayKey(attempt.startedAt);
    const entry = grouped.get(key) ?? { attempts: 0, scores: [] };
    entry.attempts += 1;
    if (typeof attempt.scorePercent === "number") entry.scores.push(attempt.scorePercent);
    grouped.set(key, entry);
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, val]) => ({
      date,
      attempts: val.attempts,
      avgScore: round2(average(val.scores))
    }));
}

function buildPerQuizAnalytics(attempts: AttemptWithRelations[]) {
  const grouped = new Map<
    string,
    {
      quizId: string;
      quizTitle: string;
      topic: string | null;
      attempts: AttemptWithRelations[];
    }
  >();

  for (const attempt of attempts) {
    const existing = grouped.get(attempt.quizId) ?? {
      quizId: attempt.quizId,
      quizTitle: attempt.quiz.title,
      topic: attempt.quiz.topic,
      attempts: []
    };
    existing.attempts.push(attempt);
    grouped.set(attempt.quizId, existing);
  }

  return [...grouped.values()]
    .map((entry) => {
      const sorted = [...entry.attempts].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
      const finished = sorted.filter((attempt) => attempt.status === "finished" && typeof attempt.scorePercent === "number");
      const scores = finished.map((attempt) => attempt.scorePercent as number);
      const firstScore = scores[0] ?? 0;
      const latestScore = scores[scores.length - 1] ?? 0;
      const completionRate = sorted.length ? (finished.length / sorted.length) * 100 : 0;
      return {
        quizId: entry.quizId,
        quizTitle: entry.quizTitle,
        topic: entry.topic,
        attempts: sorted.length,
        completionRate: round2(completionRate),
        averageScore: round2(average(scores)),
        latestScore: round2(latestScore),
        scoreTrendDelta: round2(latestScore - firstScore)
      };
    })
    .sort((a, b) => b.attempts - a.attempts);
}

function buildLearningAnalytics(attempts: AttemptWithRelations[]) {
  const weakPromptCounts = new Map<string, number>();
  const typeScores = new Map<string, number[]>();

  for (const attempt of attempts) {
    for (const answer of attempt.answers) {
      const score = answer.score ?? 0;
      if (score < 0.5) {
        weakPromptCounts.set(answer.question.prompt, (weakPromptCounts.get(answer.question.prompt) ?? 0) + 1);
      }
      const typeEntry = typeScores.get(answer.question.type) ?? [];
      typeEntry.push(score);
      typeScores.set(answer.question.type, typeEntry);
    }
  }

  const weakAreas = [...weakPromptCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([prompt, missCount]) => ({ prompt, missCount }));

  const questionTypeAccuracy = [...typeScores.entries()].map(([type, scores]) => ({
    type,
    averageScore: round2(average(scores) * 100)
  }));

  const retakeImprovement = buildPerQuizAnalytics(attempts)
    .filter((quiz) => quiz.attempts > 1)
    .map((quiz) => ({
      quizId: quiz.quizId,
      quizTitle: quiz.quizTitle,
      trendDelta: quiz.scoreTrendDelta
    }))
    .sort((a, b) => b.trendDelta - a.trendDelta);

  return {
    weakAreas,
    questionTypeAccuracy,
    retakeImprovement
  };
}

export async function getAnalyticsSnapshot(prisma: PrismaClient, filters: AnalyticsFilters) {
  const attemptWhere = {
    ...(filters.fromDate ? { startedAt: { gte: filters.fromDate } } : {}),
    ...(filters.quizId ? { quizId: filters.quizId } : {})
  };
  const quizWhere = {
    ...(filters.fromDate ? { createdAt: { gte: filters.fromDate } } : {})
  };

  const [attemptsRaw, quizzesRaw] = await Promise.all([
    prisma.attempt.findMany({
      where: attemptWhere,
      include: {
        quiz: true,
        answers: {
          include: { question: true }
        }
      },
      orderBy: { startedAt: "asc" }
    }),
    prisma.quiz.findMany({
      where: quizWhere,
      select: { id: true, title: true, topic: true, createdAt: true },
      orderBy: { createdAt: "desc" }
    })
  ]);

  const attempts = attemptsRaw as unknown as AttemptWithRelations[];
  const quizzes = quizzesRaw as QuizSummary[];
  const finishedAttempts = attempts.filter((attempt) => attempt.status === "finished");
  const finishedScores = finishedAttempts
    .map((attempt) => attempt.scorePercent)
    .filter((score): score is number => typeof score === "number");

  const latest = finishedScores[finishedScores.length - 1] ?? 0;
  const previous = finishedScores[finishedScores.length - 2] ?? latest;

  return {
    filters,
    overview: {
      totalQuizzes: quizzes.length,
      totalAttempts: attempts.length,
      completionRate: round2(attempts.length ? (finishedAttempts.length / attempts.length) * 100 : 0),
      averageScore: round2(average(finishedScores)),
      latestScoreTrend: round2(latest - previous)
    },
    charts: {
      attemptsOverTime: buildAttemptsSeries(attempts)
    },
    quizzes: buildPerQuizAnalytics(attempts),
    learning: buildLearningAnalytics(attempts),
    availableQuizzes: quizzes.map((quiz) => ({
      id: quiz.id,
      title: quiz.title,
      topic: quiz.topic
    }))
  };
}

function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function formatAttemptsCsv(attempts: Array<{
  attemptId: string;
  quizId: string;
  quizTitle: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  scorePercent: number | null;
  answerCount: number;
}>): string {
  const headers = [
    "attemptId",
    "quizId",
    "quizTitle",
    "status",
    "startedAt",
    "finishedAt",
    "scorePercent",
    "answerCount"
  ];
  const rows = attempts.map((attempt) =>
    [
      attempt.attemptId,
      attempt.quizId,
      attempt.quizTitle,
      attempt.status,
      attempt.startedAt,
      attempt.finishedAt,
      attempt.scorePercent == null ? "" : attempt.scorePercent,
      attempt.answerCount
    ]
      .map(csvEscape)
      .join(",")
  );
  return `${headers.join(",")}\n${rows.join("\n")}`;
}

export async function getAttemptsExportRows(prisma: PrismaClient, filters: AnalyticsFilters) {
  const where = {
    ...(filters.fromDate ? { startedAt: { gte: filters.fromDate } } : {}),
    ...(filters.quizId ? { quizId: filters.quizId } : {})
  };
  const attempts = await prisma.attempt.findMany({
    where,
    include: {
      quiz: true,
      answers: true
    },
    orderBy: { startedAt: "desc" }
  });

  return attempts.map((attempt) => ({
    attemptId: attempt.id,
    quizId: attempt.quizId,
    quizTitle: attempt.quiz.title,
    status: attempt.status,
    startedAt: attempt.startedAt.toISOString(),
    finishedAt: attempt.finishedAt ? attempt.finishedAt.toISOString() : "",
    scorePercent: attempt.scorePercent,
    answerCount: attempt.answers.length
  }));
}

export async function getTroubleQuestionCandidates(prisma: PrismaClient): Promise<TroubleQuestionCandidate[]> {
  const missedAnswers = await prisma.attemptAnswer.findMany({
    where: {
      score: { lt: 0.5 }
    },
    select: {
      questionId: true,
      createdAt: true,
      question: {
        select: {
          id: true,
          quizId: true,
          prompt: true,
          type: true,
          choicesJson: true,
          expectedAnswer: true,
          rubricJson: true,
          metadataJson: true
        }
      }
    }
  });

  const grouped = new Map<string, TroubleQuestionCandidate>();
  for (const answer of missedAnswers) {
    const existing = grouped.get(answer.questionId);
    if (!existing) {
      grouped.set(answer.questionId, {
        questionId: answer.question.id,
        quizId: answer.question.quizId,
        prompt: answer.question.prompt,
        type: answer.question.type,
        choicesJson: answer.question.choicesJson,
        expectedAnswer: answer.question.expectedAnswer,
        rubricJson: answer.question.rubricJson,
        metadataJson: answer.question.metadataJson,
        missCount: 1,
        lastMissedAt: answer.createdAt
      });
      continue;
    }

    existing.missCount += 1;
    if (answer.createdAt.getTime() > existing.lastMissedAt.getTime()) {
      existing.lastMissedAt = answer.createdAt;
    }
  }

  return [...grouped.values()].sort((a, b) => {
    if (b.missCount !== a.missCount) return b.missCount - a.missCount;
    return b.lastMissedAt.getTime() - a.lastMissedAt.getTime();
  });
}
