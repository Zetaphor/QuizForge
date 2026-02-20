import { describe, expect, it } from "vitest";
import { formatAttemptsCsv, parseAnalyticsFilters } from "../src/server/services/analytics.js";

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
});
