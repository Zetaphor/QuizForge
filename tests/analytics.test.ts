import { describe, expect, it } from "vitest";
import { db } from "../src/server/db.js";
import { formatAttemptsCsv, getTroubleQuestionCandidates, parseAnalyticsFilters } from "../src/server/services/analytics.js";

describe("analytics helpers", () => {
  it("parses range and fromDate correctly", () => {
    const all = parseAnalyticsFilters({ range: "all" });
    expect(all.range).toBe("all");
    expect(all.fromDate).toBeUndefined();

    const sevenDay = parseAnalyticsFilters({ range: "7d", quizId: "quiz_1" });
    expect(sevenDay.range).toBe("7d");
    expect(sevenDay.quizId).toBe("quiz_1");
    expect(sevenDay.fromDate).toBeInstanceOf(Date);

    const oneDay = parseAnalyticsFilters({ range: "1d" });
    expect(oneDay.range).toBe("1d");
    expect(oneDay.fromDate).toBeInstanceOf(Date);
  });

  it("formats attempts CSV with quoted fields", () => {
    const csv = formatAttemptsCsv([
      {
        attemptId: "a1",
        quizId: "q1",
        quizTitle: 'Quiz "A", Basics',
        status: "finished",
        startedAt: "2026-02-20T00:00:00.000Z",
        finishedAt: "2026-02-20T00:10:00.000Z",
        scorePercent: 82.5,
        answerCount: 10
      }
    ]);

    expect(csv).toContain("attemptId,quizId,quizTitle,status,startedAt,finishedAt,scorePercent,answerCount");
    expect(csv).toContain('"Quiz ""A"", Basics"');
  });

  it("ranks and dedupes missed questions for trouble candidates", async () => {
    const suffix = Date.now().toString(36);
    const quiz = await db.quiz.create({
      data: {
        title: `analytics-quiz-${suffix}`,
        topic: "Testing",
        quizJson: JSON.stringify({ summary: "test", questions: [] })
      }
    });

    const [q1, q2] = await Promise.all([
      db.question.create({
        data: {
          quizId: quiz.id,
          questionIndex: 0,
          type: "open_ended",
          prompt: "Hard concept A"
        }
      }),
      db.question.create({
        data: {
          quizId: quiz.id,
          questionIndex: 1,
          type: "open_ended",
          prompt: "Hard concept B"
        }
      })
    ]);

    const attempt = await db.attempt.create({
      data: { quizId: quiz.id, status: "finished", finishedAt: new Date() }
    });

    await db.attemptAnswer.createMany({
      data: [
        { attemptId: attempt.id, questionId: q2.id, userAnswer: "x", correctness: "incorrect", score: 0, createdAt: new Date("2026-01-01T00:00:00.000Z") },
        { attemptId: attempt.id, questionId: q1.id, userAnswer: "y", correctness: "incorrect", score: 0, createdAt: new Date("2026-01-03T00:00:00.000Z") },
        { attemptId: attempt.id, questionId: q1.id, userAnswer: "z", correctness: "incorrect", score: 0, createdAt: new Date("2026-01-04T00:00:00.000Z") }
      ]
    });

    const candidates = await getTroubleQuestionCandidates(db);
    const picked = candidates.filter((candidate) => candidate.questionId === q1.id || candidate.questionId === q2.id);

    expect(picked).toHaveLength(2);
    expect(picked[0].questionId).toBe(q1.id);
    expect(picked[0].missCount).toBe(2);
    expect(picked[1].questionId).toBe(q2.id);
    expect(picked[1].missCount).toBe(1);
  });
});
