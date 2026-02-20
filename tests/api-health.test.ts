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
});
