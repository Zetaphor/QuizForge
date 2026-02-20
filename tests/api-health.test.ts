import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";

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

  it("validates chat endpoint payload", async () => {
    const app = createApp();
    const response = await request(app).post("/api/attempts/example-attempt/chat").send({});
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "message is required." });
  });
});
