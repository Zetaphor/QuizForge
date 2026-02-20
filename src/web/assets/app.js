async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

window.sourcePage = function sourcePage() {
  return {
    files: [],
    youtubeUrls: "",
    sourceIds: JSON.parse(localStorage.getItem("sourceIds") || "[]"),
    title: "",
    description: "",
    topic: "",
    autoMetadata: true,
    questionCount: 8,
    status: "",
    loading: false,
    generationSteps: [
      "Preparing source context",
      "Analyzing concepts and misconceptions",
      "Drafting mixed question set",
      "Running quiz quality critique",
      "Finalizing quiz JSON and saving"
    ],
    generationStepIndex: -1,
    generationTickHandle: null,
    get currentGenerationStep() {
      if (this.generationStepIndex < 0) return "";
      return this.generationSteps[this.generationStepIndex] ?? "";
    },
    startGenerationTicker() {
      this.generationStepIndex = 0;
      this.generationTickHandle = window.setInterval(() => {
        this.generationStepIndex = Math.min(this.generationStepIndex + 1, this.generationSteps.length - 1);
      }, 1800);
    },
    stopGenerationTicker() {
      if (this.generationTickHandle) {
        window.clearInterval(this.generationTickHandle);
      }
      this.generationTickHandle = null;
      this.generationStepIndex = -1;
    },
    onFilesChanged(event) {
      this.files = Array.from(event.target.files || []);
    },
    async ingestSources() {
      this.loading = true;
      this.status = "Ingesting sources...";
      try {
        const form = new FormData();
        for (const file of this.files) {
          form.append("markdownFiles", file);
        }
        form.append("youtubeUrls", this.youtubeUrls);

        const result = await jsonFetch("/api/sources/ingest", {
          method: "POST",
          body: form
        });
        this.sourceIds = result.sourceIds || [];
        localStorage.setItem("sourceIds", JSON.stringify(this.sourceIds));
        const warningCount = Array.isArray(result.warnings) ? result.warnings.length : 0;
        this.status =
          warningCount > 0
            ? `Stored ${this.sourceIds.length} source(s), ${warningCount} source(s) could not be ingested.`
            : `Stored ${this.sourceIds.length} source(s).`;
      } catch (error) {
        this.status = error.message;
      } finally {
        this.loading = false;
      }
    },
    async generateQuiz() {
      if (!this.sourceIds.length) {
        this.status = "Please ingest sources first.";
        return;
      }
      this.loading = true;
      this.status = "Starting iterative quiz generation...";
      this.startGenerationTicker();
      console.info("[QuizGen] Request started.");
      try {
        const result = await jsonFetch("/api/quizzes/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceIds: this.sourceIds,
            title: this.autoMetadata ? undefined : this.title || undefined,
            description: this.autoMetadata ? undefined : this.description || undefined,
            topic: this.topic || undefined,
            autoMetadata: this.autoMetadata,
            questionCount: this.questionCount
          })
        });
        localStorage.setItem("quizId", result.quizId);
        console.info("[QuizGen] Complete. Redirecting to quiz UI.", { quizId: result.quizId });
        window.location.href = `/quiz?quizId=${encodeURIComponent(result.quizId)}`;
      } catch (error) {
        console.error("[QuizGen] Failed.", error);
        this.status = error.message;
      } finally {
        this.stopGenerationTicker();
        this.loading = false;
      }
    }
  };
};

window.quizPage = function quizPage() {
  return {
    quizId: "",
    attemptId: "",
    quiz: { title: "", topic: "", summary: "", questions: [] },
    loading: true,
    index: 0,
    userAnswer: "",
    feedback: "",
    get currentQuestion() {
      return this.quiz.questions[this.index];
    },
    async init() {
      const params = new URLSearchParams(window.location.search);
      this.quizId = params.get("quizId") || localStorage.getItem("quizId") || "";
      if (!this.quizId) {
        this.feedback = "Missing quizId.";
        this.loading = false;
        return;
      }
      localStorage.setItem("quizId", this.quizId);

      try {
        this.quiz = await jsonFetch(`/api/quizzes/${encodeURIComponent(this.quizId)}`);
        const attempt = await jsonFetch(`/api/quizzes/${encodeURIComponent(this.quizId)}/attempts`, {
          method: "POST"
        });
        this.attemptId = attempt.attemptId;
      } catch (error) {
        this.feedback = error.message;
      } finally {
        this.loading = false;
      }
    },
    async submitAnswer() {
      if (!this.currentQuestion || !this.attemptId) return;
      try {
        const result = await jsonFetch(`/api/attempts/${encodeURIComponent(this.attemptId)}/answers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            questionId: this.currentQuestion.id,
            userAnswer: this.userAnswer
          })
        });
        this.feedback = `${result.correctness.toUpperCase()}: ${result.feedback || ""}`;
      } catch (error) {
        this.feedback = error.message;
      }
    },
    nextQuestion() {
      if (this.index < this.quiz.questions.length - 1) {
        this.index += 1;
        this.userAnswer = "";
        this.feedback = "";
      }
    },
    async finishAttempt() {
      if (!this.attemptId) return;
      try {
        await jsonFetch(`/api/attempts/${encodeURIComponent(this.attemptId)}/finish`, {
          method: "POST"
        });
        window.location.href = `/results?quizId=${encodeURIComponent(this.quizId)}`;
      } catch (error) {
        this.feedback = error.message;
      }
    }
  };
};

window.resultsPage = function resultsPage() {
  return {
    quizId: "",
    attempts: [],
    async init() {
      const params = new URLSearchParams(window.location.search);
      this.quizId = params.get("quizId") || localStorage.getItem("quizId") || "";
      if (!this.quizId) return;
      const result = await jsonFetch(`/api/quizzes/${encodeURIComponent(this.quizId)}/attempts`);
      this.attempts = result.attempts || [];
    },
    retake() {
      if (!this.quizId) return;
      window.location.href = `/quiz?quizId=${encodeURIComponent(this.quizId)}`;
    }
  };
};
