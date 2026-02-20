import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TestProject } from "vitest/node";

function removeTestSqliteFiles(projectRoot: string) {
  const basePath = path.resolve(projectRoot, "prisma", "quiz.test.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${basePath}${suffix}`, { force: true });
    } catch {
      // Ignore cleanup errors for missing files.
    }
  }
}

export default function globalSetup(project: TestProject) {
  const projectRoot = project.config.root;
  const env = { ...process.env, DATABASE_URL: "file:./quiz.test.db" };

  // Start each test run with a clean isolated SQLite DB.
  removeTestSqliteFiles(projectRoot);
  execSync("npx prisma db push --skip-generate", {
    cwd: projectRoot,
    env,
    stdio: "pipe"
  });

  return () => {
    removeTestSqliteFiles(projectRoot);
  };
}
