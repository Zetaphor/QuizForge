import { describe, expect, it } from "vitest";
import { extractVideoId } from "../src/server/services/transcript.js";

describe("extractVideoId", () => {
  it("extracts from watch URL", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from shorts URL", () => {
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for invalid URL", () => {
    expect(extractVideoId("https://example.com/video")).toBeNull();
  });
});
