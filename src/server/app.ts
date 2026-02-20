import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { db } from "./db.js";
import {
  formatAttemptsCsv,
  getAnalyticsSnapshot,
  getAttemptsExportRows,
  getTroubleQuestionCandidates,
  parseAnalyticsFilters
} from "./services/analytics.js";
import { generateQuizIteratively, type FinalQuiz } from "./services/quiz-generator.js";
import {
  hashContent,
  normalizeMarkdownSource,
  normalizeYouTubeSource,
  type NormalizedSource
} from "./services/ingestion.js";
import { gradeOpenEndedAnswer } from "./services/open-ended-grader.js";
import { generateQuizChatReply } from "./services/quiz-chat.js";
import { scoreMultipleChoice } from "./services/scoring.js";
import { getYouTubeTranscript } from "./services/transcript.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

const upload = multer({ storage: multer.memoryStorage() });

function parseYouTubeInputs(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((item) => String(item).trim()).filter(Boolean);
  const raw = String(input);
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  return raw
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toNormalizedSource(doc: { origin: string; title: string | null; externalRef: string | null; content: string }): NormalizedSource {
  return {
    origin: doc.origin === "youtube" ? "youtube" : "markdown",
    title: doc.title ?? "Untitled Source",
    externalRef: doc.externalRef ?? undefined,
    content: doc.content
  };
}

function toBoolean(input: unknown): boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "string") return ["1", "true", "yes", "on"].includes(input.trim().toLowerCase());
  return false;
}

function clampQuestionCount(value: number): number {
  return Math.max(4, Math.min(20, Math.round(value)));
}

function parseQuestionCount(input: unknown): number | undefined {
  if (typeof input !== "number" || !Number.isFinite(input)) return undefined;
  return clampQuestionCount(input);
}

function parseTroubleMode(input: unknown): "reuse_exact" | "regenerate_similar" | null {
  if (input === "reuse_exact" || input === "regenerate_similar") return input;
  return null;
}

async function saveQuizFromGeneratedPayload(params: {
  quiz: FinalQuiz;
  metadata: Record<string, unknown>;
  difficulty?: unknown;
  sourceDocs?: Array<{ id: string }>;
}) {
  const { quiz, metadata, difficulty, sourceDocs } = params;
  return db.$transaction(async (tx) => {
    const created = await tx.quiz.create({
      data: {
        title: quiz.title,
        topic: quiz.topic,
        difficulty: typeof difficulty === "string" ? difficulty : "mixed",
        generationMetadata: JSON.stringify(metadata),
        quizJson: JSON.stringify(quiz),
        ...(sourceDocs?.length
          ? {
              sources: {
                create: sourceDocs.map((source) => ({
                  sourceId: source.id
                }))
              }
            }
          : {})
      }
    });

    for (const [index, question] of quiz.questions.entries()) {
      await tx.question.create({
        data: {
          quizId: created.id,
          questionIndex: index,
          type: question.type,
          prompt: question.prompt,
          choicesJson: question.choices ? JSON.stringify(question.choices) : null,
          expectedAnswer: question.expectedAnswer ?? null,
          rubricJson: question.rubric ? JSON.stringify({ rubric: question.rubric }) : null,
          metadataJson: JSON.stringify({ explanation: question.explanation ?? null, correctChoiceIndex: question.correctChoiceIndex ?? null })
        }
      });
    }

    return created;
  });
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use("/assets", express.static(path.join(projectRoot, "src/web/assets")));

  app.get("/", (_req, res) => res.sendFile(path.join(projectRoot, "src/web/pages/dashboard.html")));
  app.get("/builder", (_req, res) => res.sendFile(path.join(projectRoot, "src/web/pages/index.html")));
  app.get("/quiz", (_req, res) => res.sendFile(path.join(projectRoot, "src/web/pages/quiz.html")));
  app.get("/results", (_req, res) => res.sendFile(path.join(projectRoot, "src/web/pages/results.html")));
  app.get("/dashboard", (_req, res) => res.sendFile(path.join(projectRoot, "src/web/pages/dashboard.html")));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/sources/ingest", upload.array("markdownFiles"), async (req, res) => {
    try {
      const normalized: NormalizedSource[] = [];
      const warnings: Array<{ input: string; error: string }> = [];
      const markdownFiles = (req.files as Express.Multer.File[]) ?? [];
      for (const file of markdownFiles) {
        const text = file.buffer.toString("utf8");
        normalized.push(normalizeMarkdownSource(file.originalname, text));
      }

      const youtubeInputs = parseYouTubeInputs(req.body.youtubeUrls);
      for (const input of youtubeInputs) {
        try {
          const transcript = await getYouTubeTranscript(input);
          normalized.push(normalizeYouTubeSource(transcript.videoId, transcript.transcriptText));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown YouTube ingestion error.";
          warnings.push({ input, error: message });
        }
      }

      if (!normalized.length) {
        if (warnings.length) {
          return res.status(422).json({
            error: "No sources were ingested successfully.",
            warnings
          });
        }
        return res.status(400).json({ error: "Provide at least one markdown file or YouTube URL." });
      }

      const created = [];
      for (const source of normalized) {
        const record = await db.sourceDocument.create({
          data: {
            origin: source.origin,
            title: source.title,
            externalRef: source.externalRef,
            content: source.content,
            contentHash: hashContent(source.content),
            metadata: source.metadata ? JSON.stringify(source.metadata) : null
          }
        });
        created.push(record);
      }

      return res.json({
        sourceIds: created.map((item) => item.id),
        sources: created,
        warnings
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown ingestion error.";
      return res.status(500).json({ error: message });
    }
  });

  app.post("/api/quizzes/generate", async (req, res) => {
    const requestId = `quiz-${Date.now().toString(36)}`;
    const startedAt = Date.now();
    try {
      console.log(`[${requestId}] Quiz generation request received.`);
      const sourceIds: string[] = Array.isArray(req.body.sourceIds) ? req.body.sourceIds : [];
      if (!sourceIds.length) {
        return res.status(400).json({ error: "sourceIds is required." });
      }

      const sourceDocs = await db.sourceDocument.findMany({
        where: {
          id: { in: sourceIds }
        }
      });

      if (!sourceDocs.length) {
        return res.status(404).json({ error: "No sources found for sourceIds." });
      }
      console.log(`[${requestId}] Loaded ${sourceDocs.length} source(s).`);

      const { quiz, metadata } = await generateQuizIteratively({
        sources: sourceDocs.map(toNormalizedSource),
        title: req.body.title,
        description: req.body.description,
        topic: req.body.topic,
        autoMetadata: toBoolean(req.body.autoMetadata),
        questionCount: parseQuestionCount(req.body.questionCount)
      });

      const createdQuiz = await saveQuizFromGeneratedPayload({
        quiz,
        metadata,
        difficulty: req.body.difficulty,
        sourceDocs: sourceDocs.map((source) => ({ id: source.id }))
      });
      console.log(`[${requestId}] Quiz ${createdQuiz.id} saved in ${Date.now() - startedAt}ms.`);

      return res.json({ quizId: createdQuiz.id, quiz });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Quiz generation failed.";
      console.error(`[${requestId}] Quiz generation failed after ${Date.now() - startedAt}ms: ${message}`);
      return res.status(500).json({ error: message });
    }
  });

  app.post("/api/quizzes/custom/trouble", async (req, res) => {
    const mode = parseTroubleMode(req.body?.mode);
    if (!mode) {
      return res.status(400).json({ error: "mode must be 'reuse_exact' or 'regenerate_similar'." });
    }

    const requestedCount = parseQuestionCount(req.body?.questionCount);
    const customTitle = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const candidates = await getTroubleQuestionCandidates(db);
    if (!candidates.length) {
      return res.status(404).json({ error: "No missed questions found yet. Complete at least one quiz attempt first." });
    }

    if (mode === "reuse_exact") {
      const selected = requestedCount ? candidates.slice(0, requestedCount) : candidates;
      const safeSelected = selected.slice(0, 20);
      const quiz = {
        title: customTitle || "Trouble Questions Practice",
        topic: "Targeted Review",
        summary: "A focused quiz built from questions you have previously missed.",
        questions: safeSelected.map((item) => {
          const metadata = item.metadataJson ? JSON.parse(item.metadataJson) : {};
          return {
            type: item.type === "multiple_choice" ? "multiple_choice" : "open_ended",
            prompt: item.prompt,
            choices: item.choicesJson ? (JSON.parse(item.choicesJson) as string[]) : undefined,
            correctChoiceIndex:
              typeof metadata.correctChoiceIndex === "number" ? Number(metadata.correctChoiceIndex) : undefined,
            expectedAnswer: item.expectedAnswer ?? undefined,
            rubric: item.rubricJson ? JSON.parse(item.rubricJson).rubric : undefined,
            explanation: typeof metadata.explanation === "string" ? metadata.explanation : undefined
          };
        })
      } satisfies FinalQuiz;

      const createdQuiz = await saveQuizFromGeneratedPayload({
        quiz,
        metadata: {
          generationMode: "trouble_custom",
          troubleQuiz: {
            mode,
            selectedQuestionCount: safeSelected.length,
            weakPromptCount: candidates.length
          }
        }
      });

      return res.json({
        quizId: createdQuiz.id,
        quiz,
        selectionSummary: {
          weakPromptCount: candidates.length,
          selectedQuestionCount: safeSelected.length
        }
      });
    }

    const sourceQuizIds = [...new Set(candidates.map((candidate) => candidate.quizId))];
    const sourceDocs = await db.sourceDocument.findMany({
      where: {
        quizzes: {
          some: {
            quizId: { in: sourceQuizIds }
          }
        }
      }
    });

    if (!sourceDocs.length) {
      return res.status(400).json({
        error: "Could not build source context for regenerated trouble quiz. Try exact-reuse mode instead."
      });
    }

    const focusPrompts = candidates.slice(0, 12).map((candidate) => candidate.prompt);
    const { quiz, metadata } = await generateQuizIteratively({
      sources: sourceDocs.map(toNormalizedSource),
      title: customTitle || "Trouble Questions Remix",
      description: "A regenerated quiz focused on your most-missed concepts.",
      topic: "Targeted Review",
      autoMetadata: false,
      questionCount: requestedCount,
      focusPrompts
    });

    const createdQuiz = await saveQuizFromGeneratedPayload({
      quiz,
      metadata: {
        ...metadata,
        troubleQuiz: {
          mode,
          weakPromptCount: candidates.length,
          sourceCount: sourceDocs.length
        }
      },
      sourceDocs: sourceDocs.map((source) => ({ id: source.id }))
    });

    return res.json({
      quizId: createdQuiz.id,
      quiz,
      selectionSummary: {
        weakPromptCount: candidates.length,
        sourceCount: sourceDocs.length
      }
    });
  });

  app.get("/api/quizzes", async (_req, res) => {
    const quizzes = await db.quiz.findMany({
      include: {
        questions: true,
        attempts: true
      },
      orderBy: { createdAt: "desc" }
    });

    return res.json({
      quizzes: quizzes.map((quiz) => {
        const finishedAttempts = quiz.attempts.filter(
          (attempt) => attempt.status === "finished" && typeof attempt.scorePercent === "number"
        );
        const latestAttempt = quiz.attempts.reduce<(typeof quiz.attempts)[number] | null>((latest, attempt) => {
          if (!latest) return attempt;
          return attempt.startedAt.getTime() > latest.startedAt.getTime() ? attempt : latest;
        }, null);
        const totalFinishedScore = finishedAttempts.reduce(
          (sum, attempt) => sum + (attempt.scorePercent ?? 0),
          0
        );
        const averageScorePercent = finishedAttempts.length
          ? totalFinishedScore / finishedAttempts.length
          : null;
        const latestFinishedAttempt = finishedAttempts.sort(
          (left, right) => (right.finishedAt?.getTime() ?? 0) - (left.finishedAt?.getTime() ?? 0)
        )[0];
        return {
          id: quiz.id,
          title: quiz.title,
          topic: quiz.topic,
          createdAt: quiz.createdAt,
          questionCount: quiz.questions.length,
          attemptCount: quiz.attempts.length,
          completionCount: quiz.attempts.filter((attempt) => attempt.status === "finished").length,
          lastAttemptAt: latestAttempt?.startedAt ?? null,
          lastScorePercent: latestFinishedAttempt?.scorePercent ?? null,
          averageScorePercent
        };
      })
    });
  });

  app.delete("/api/quizzes/:id", async (req, res) => {
    const quiz = await db.quiz.findUnique({
      where: { id: req.params.id },
      select: { id: true, title: true }
    });
    if (!quiz) return res.status(404).json({ error: "Quiz not found." });

    await db.quiz.delete({
      where: { id: quiz.id }
    });

    return res.json({
      ok: true,
      deletedQuiz: {
        id: quiz.id,
        title: quiz.title
      }
    });
  });

  app.get("/api/quizzes/:id", async (req, res) => {
    const quiz = await db.quiz.findUnique({
      where: { id: req.params.id },
      include: {
        questions: { orderBy: { questionIndex: "asc" } },
        sources: {
          include: {
            source: true
          }
        }
      }
    });
    if (!quiz) return res.status(404).json({ error: "Quiz not found." });

    return res.json({
      id: quiz.id,
      title: quiz.title,
      topic: quiz.topic,
      summary: JSON.parse(quiz.quizJson).summary ?? "",
      questions: quiz.questions.map((q) => ({
        id: q.id,
        type: q.type,
        prompt: q.prompt,
        choices: q.choicesJson ? JSON.parse(q.choicesJson) : []
      })),
      sources: quiz.sources.map((item) => ({
        id: item.source.id,
        origin: item.source.origin,
        title: item.source.title ?? "Untitled Source",
        externalRef: item.source.externalRef,
        content: item.source.content
      }))
    });
  });

  app.post("/api/quizzes/:id/attempts", async (req, res) => {
    const quiz = await db.quiz.findUnique({ where: { id: req.params.id } });
    if (!quiz) return res.status(404).json({ error: "Quiz not found." });
    const attempt = await db.attempt.create({
      data: {
        quizId: quiz.id
      }
    });
    return res.json({ attemptId: attempt.id, quizId: quiz.id });
  });

  app.post("/api/attempts/:attemptId/answers", async (req, res) => {
    const attempt = await db.attempt.findUnique({
      where: { id: req.params.attemptId }
    });
    if (!attempt) return res.status(404).json({ error: "Attempt not found." });
    if (attempt.status === "finished") return res.status(409).json({ error: "Attempt is already finished." });

    const questionId = String(req.body.questionId ?? "");
    const userAnswer = String(req.body.userAnswer ?? "");
    const retryIndex = Number.isFinite(req.body.retryIndex) ? Number(req.body.retryIndex) : 0;
    if (!questionId || !userAnswer.trim()) {
      return res.status(400).json({ error: "questionId and userAnswer are required." });
    }

    const question = await db.question.findUnique({ where: { id: questionId } });
    if (!question || question.quizId !== attempt.quizId) {
      return res.status(404).json({ error: "Question not found for this attempt." });
    }

    let correctness: "correct" | "incorrect" | "partially_correct" = "incorrect";
    let score = 0;
    let feedback = "";
    let followup = "";
    let graderJson: Record<string, unknown> = {};

    if (question.type === "multiple_choice") {
      const metadata = question.metadataJson ? JSON.parse(question.metadataJson) : {};
      const correctChoiceIndex = Number(metadata.correctChoiceIndex);
      const graded = scoreMultipleChoice(correctChoiceIndex, userAnswer);
      correctness = graded.correctness;
      score = graded.score;
      feedback = graded.correctness === "correct" ? "Correct choice." : "That choice is not correct.";
    } else {
      const rubric = question.rubricJson ? JSON.parse(question.rubricJson).rubric : null;
      const graded = await gradeOpenEndedAnswer({
        prompt: question.prompt,
        expectedAnswer: question.expectedAnswer,
        rubric,
        userAnswer
      });
      correctness = graded.correctness;
      score = graded.correctness === "correct" ? 1 : graded.correctness === "partially_correct" ? 0.5 : 0;
      feedback = graded.explanation;
      followup = graded.followup;
      graderJson = graded;
    }

    const answer = await db.attemptAnswer.create({
      data: {
        attemptId: attempt.id,
        questionId,
        userAnswer,
        correctness,
        score,
        feedback,
        followup,
        graderJson: JSON.stringify(graderJson),
        retryIndex
      }
    });

    return res.json({
      answerId: answer.id,
      correctness,
      score,
      feedback,
      followup
    });
  });

  app.post("/api/attempts/:attemptId/chat", async (req, res) => {
    const message = String(req.body.message ?? "").trim();
    const questionId = typeof req.body.questionId === "string" ? req.body.questionId : undefined;
    const questionIndex = Number.isFinite(req.body.questionIndex) ? Number(req.body.questionIndex) : undefined;
    if (!message) {
      return res.status(400).json({ error: "message is required." });
    }

    const attempt = await db.attempt.findUnique({
      where: { id: req.params.attemptId },
      include: {
        quiz: {
          include: {
            questions: { orderBy: { questionIndex: "asc" } }
          }
        },
        answers: {
          orderBy: { createdAt: "asc" }
        }
      }
    });
    if (!attempt) return res.status(404).json({ error: "Attempt not found." });
    if (attempt.status === "finished") return res.status(409).json({ error: "Attempt is already finished." });

    if (questionId) {
      const questionForAttempt = attempt.quiz.questions.find((question) => question.id === questionId);
      if (!questionForAttempt) return res.status(404).json({ error: "Question not found for this attempt." });
    }

    try {
      const chat = await generateQuizChatReply({
        quiz: {
          title: attempt.quiz.title,
          topic: attempt.quiz.topic,
          summary: JSON.parse(attempt.quiz.quizJson).summary ?? "",
          questions: attempt.quiz.questions.map((question) => ({
            id: question.id,
            prompt: question.prompt,
            type: question.type
          }))
        },
        answers: attempt.answers.map((answer) => ({
          questionId: answer.questionId,
          userAnswer: answer.userAnswer,
          correctness: answer.correctness,
          feedback: answer.feedback,
          createdAt: answer.createdAt
        })),
        message,
        questionId,
        questionIndex
      });
      return res.json(chat);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to generate chat response.";
      return res.status(500).json({ error: message });
    }
  });

  app.post("/api/attempts/:attemptId/finish", async (req, res) => {
    const attempt = await db.attempt.findUnique({
      where: { id: req.params.attemptId },
      include: {
        quiz: {
          include: { questions: true }
        },
        answers: {
          orderBy: { createdAt: "asc" }
        }
      }
    });
    if (!attempt) return res.status(404).json({ error: "Attempt not found." });
    if (attempt.status === "finished") return res.json({ scorePercent: attempt.scorePercent });

    const latestByQuestion = new Map<string, { score: number | null }>();
    for (const answer of attempt.answers) {
      latestByQuestion.set(answer.questionId, { score: answer.score });
    }

    const totalQuestions = attempt.quiz.questions.length || 1;
    let earned = 0;
    for (const question of attempt.quiz.questions) {
      earned += latestByQuestion.get(question.id)?.score ?? 0;
    }

    const scorePercent = (earned / totalQuestions) * 100;
    const weakAreas = attempt.quiz.questions
      .filter((question) => (latestByQuestion.get(question.id)?.score ?? 0) < 0.5)
      .map((question) => question.prompt);

    await db.attempt.update({
      where: { id: attempt.id },
      data: {
        finishedAt: new Date(),
        scorePercent,
        status: "finished",
        summaryJson: JSON.stringify({ weakAreas })
      }
    });

    return res.json({ scorePercent, weakAreas });
  });

  app.get("/api/quizzes/:id/attempts", async (req, res) => {
    const attempts = await db.attempt.findMany({
      where: { quizId: req.params.id },
      include: { answers: true },
      orderBy: { startedAt: "desc" }
    });
    return res.json({
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        status: attempt.status,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        scorePercent: attempt.scorePercent,
        summary: attempt.summaryJson ? JSON.parse(attempt.summaryJson) : null,
        answerCount: attempt.answers.length
      }))
    });
  });

  app.get("/api/analytics/overview", async (req, res) => {
    try {
      const filters = parseAnalyticsFilters({
        range: typeof req.query.range === "string" ? req.query.range : undefined,
        quizId: typeof req.query.quizId === "string" ? req.query.quizId : undefined
      });
      const snapshot = await getAnalyticsSnapshot(db, filters);
      return res.json({
        filters: snapshot.filters,
        overview: snapshot.overview,
        charts: snapshot.charts,
        availableQuizzes: snapshot.availableQuizzes
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load overview analytics.";
      return res.status(500).json({ error: message });
    }
  });

  app.get("/api/analytics/quizzes", async (req, res) => {
    try {
      const filters = parseAnalyticsFilters({
        range: typeof req.query.range === "string" ? req.query.range : undefined,
        quizId: typeof req.query.quizId === "string" ? req.query.quizId : undefined
      });
      const snapshot = await getAnalyticsSnapshot(db, filters);
      return res.json({
        filters: snapshot.filters,
        quizzes: snapshot.quizzes
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load per-quiz analytics.";
      return res.status(500).json({ error: message });
    }
  });

  app.get("/api/analytics/learning", async (req, res) => {
    try {
      const filters = parseAnalyticsFilters({
        range: typeof req.query.range === "string" ? req.query.range : undefined,
        quizId: typeof req.query.quizId === "string" ? req.query.quizId : undefined
      });
      const snapshot = await getAnalyticsSnapshot(db, filters);
      return res.json({
        filters: snapshot.filters,
        learning: snapshot.learning
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load learning analytics.";
      return res.status(500).json({ error: message });
    }
  });

  app.get("/api/analytics/export.csv", async (req, res) => {
    try {
      const filters = parseAnalyticsFilters({
        range: typeof req.query.range === "string" ? req.query.range : undefined,
        quizId: typeof req.query.quizId === "string" ? req.query.quizId : undefined
      });
      const rows = await getAttemptsExportRows(db, filters);
      const csv = formatAttemptsCsv(rows);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=quiz-analytics.csv");
      return res.send(csv);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to export analytics.";
      return res.status(500).json({ error: message });
    }
  });

  return app;
}
