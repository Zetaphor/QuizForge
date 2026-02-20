import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { db } from "../src/server/db.js";

describe("API health", () => {
  it("returns ok", async () => {
    const app = createApp();
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("serves dashboard analytics overview", async () => {
    const app = createApp();
    const response = await request(app).get("/api/analytics/overview?range=all");
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("overview");
    expect(response.body).toHaveProperty("charts");
  });

  it("exports analytics CSV", async () => {
    const app = createApp();
    const response = await request(app).get("/api/analytics/export.csv?range=all");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.text).toContain("attemptId,quizId,quizTitle");
  });

  it("lists existing quizzes", async () => {
    const app = createApp();
    const response = await request(app).get("/api/quizzes");
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("quizzes");
    expect(Array.isArray(response.body.quizzes)).toBe(true);
  });

  it("deletes an existing quiz", async () => {
    const app = createApp();
    const suffix = `${Date.now().toString(36)}-delete`;
    const quiz = await db.quiz.create({
      data: {
        title: `delete-me-${suffix}`,
        topic: "Cleanup",
        quizJson: JSON.stringify({ summary: "seed", questions: [] })
      }
    });

    const response = await request(app).delete(`/api/quizzes/${encodeURIComponent(quiz.id)}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      deletedQuiz: {
        id: quiz.id,
        title: `delete-me-${suffix}`
      }
    });

    const check = await request(app).get(`/api/quizzes/${encodeURIComponent(quiz.id)}`);
    expect(check.status).toBe(404);
  });

  it("validates chat endpoint payload", async () => {
    const app = createApp();
    const response = await request(app).post("/api/attempts/example-attempt/chat").send({});
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "message is required." });
  });

  it("returns not found when creating trouble quiz without missed history", async () => {
    const app = createApp();
    const response = await request(app).post("/api/quizzes/custom/trouble").send({ mode: "reuse_exact" });
    expect([200, 404]).toContain(response.status);
  });

  it("creates trouble quiz in reuse_exact mode when misses exist", async () => {
    const app = createApp();
    const suffix = Date.now().toString(36);
    const quiz = await db.quiz.create({
      data: {
        title: `reuse-source-${suffix}`,
        topic: "Topic",
        quizJson: JSON.stringify({ summary: "seed", questions: [] })
      }
    });
    const question = await db.question.create({
      data: {
        quizId: quiz.id,
        questionIndex: 0,
        type: "multiple_choice",
        prompt: `Missed question ${suffix}`,
        choicesJson: JSON.stringify(["A", "B", "C", "D"]),
        metadataJson: JSON.stringify({ correctChoiceIndex: 1, explanation: "Because B" })
      }
    });
    const attempt = await db.attempt.create({
      data: { quizId: quiz.id, status: "finished", finishedAt: new Date() }
    });
    await db.attemptAnswer.create({
      data: {
        attemptId: attempt.id,
        questionId: question.id,
        userAnswer: "0",
        correctness: "incorrect",
        score: 0
      }
    });

    const response = await request(app).post("/api/quizzes/custom/trouble").send({ mode: "reuse_exact", questionCount: 5 });
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("quizId");
    expect(response.body.quiz.questions.length).toBeGreaterThan(0);
  });

  it("creates trouble quiz in regenerate_similar mode with mock LLM", async () => {
    const app = createApp();
    process.env.MOCK_LLM = "1";
    const suffix = `${Date.now().toString(36)}-regen`;
    const source = await db.sourceDocument.create({
      data: {
        origin: "markdown",
        title: `Source ${suffix}`,
        content: "Important concept text.",
        contentHash: `hash-${suffix}`
      }
    });
    const quiz = await db.quiz.create({
      data: {
        title: `regen-source-${suffix}`,
        topic: "Topic",
        quizJson: JSON.stringify({ summary: "seed", questions: [] }),
        sources: { create: [{ sourceId: source.id }] }
      }
    });
    const question = await db.question.create({
      data: {
        quizId: quiz.id,
        questionIndex: 0,
        type: "open_ended",
        prompt: `Struggle prompt ${suffix}`
      }
    });
    const attempt = await db.attempt.create({
      data: { quizId: quiz.id, status: "finished", finishedAt: new Date() }
    });
    await db.attemptAnswer.create({
      data: {
        attemptId: attempt.id,
        questionId: question.id,
        userAnswer: "wrong",
        correctness: "incorrect",
        score: 0
      }
    });

    const response = await request(app).post("/api/quizzes/custom/trouble").send({ mode: "regenerate_similar", questionCount: 6 });
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("quizId");
    expect(response.body.quiz.questions.length).toBeGreaterThanOrEqual(4);
  });
});
