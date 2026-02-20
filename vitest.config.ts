import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "file:./quiz.test.db"
    },
    globalSetup: ["./tests/global-setup.ts"]
  }
});
