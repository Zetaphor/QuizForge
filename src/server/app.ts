import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { db } from "./db.js";
import { generateQuizIteratively } from "./services/quiz-generator.js";
import {
  hashContent,
  normalizeMarkdownSource,
  normalizeYouTubeSource,
  type NormalizedSource
} from "./services/ingestion.js";
import { gradeOpenEndedAnswer } from "./services/open-ended-grader.js";
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

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use("/assets", express.static(path.join(projectRoot, "src/web/assets")));

  app.get("/", (_req, res) => res.sendFile(path.join(projectRoot, "src/web/pages/index.html")));
  app.get("/quiz", (_req, res) => res.sendFile(path.join(projectRoot, "src/web/pages/quiz.html")));
  app.get("/results", (_req, res) => res.sendFile(path.join(projectRoot, "src/web/pages/results.html")));

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
        questionCount: typeof req.body.questionCount === "number" ? req.body.questionCount : undefined
      });

      const createdQuiz = await db.$transaction(async (tx) => {
        const created = await tx.quiz.create({
          data: {
            title: quiz.title,
            topic: quiz.topic,
            difficulty: req.body.difficulty ?? "mixed",
            generationMetadata: JSON.stringify(metadata),
            quizJson: JSON.stringify(quiz),
            sources: {
              create: sourceDocs.map((source) => ({
                sourceId: source.id
              }))
            }
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
      console.log(`[${requestId}] Quiz ${createdQuiz.id} saved in ${Date.now() - startedAt}ms.`);

      return res.json({ quizId: createdQuiz.id, quiz });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Quiz generation failed.";
      console.error(`[${requestId}] Quiz generation failed after ${Date.now() - startedAt}ms: ${message}`);
      return res.status(500).json({ error: message });
    }
  });

  app.get("/api/quizzes/:id", async (req, res) => {
    const quiz = await db.quiz.findUnique({
      where: { id: req.params.id },
      include: {
        questions: { orderBy: { questionIndex: "asc" } }
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

  return app;
}
