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
    autoQuestionCount: true,
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
    clampQuestionCount(value) {
      return Math.max(4, Math.min(20, Math.round(value)));
    },
    get estimatedQuestionCount() {
      const youtubeCount = this.youtubeUrls
        .split(/\n+/)
        .map((item) => item.trim())
        .filter(Boolean).length;
      const fileBytes = this.files.reduce((sum, file) => sum + (file.size || 0), 0);
      const inferredIngestedBytes =
        this.sourceIds.length > 0 && fileBytes === 0 && youtubeCount === 0 ? this.sourceIds.length * 4000 : 0;
      const estimatedBytes = fileBytes + youtubeCount * 12000 + inferredIngestedBytes;

      let base = 6;
      if (estimatedBytes >= 25000) base = 14;
      else if (estimatedBytes >= 12000) base = 12;
      else if (estimatedBytes >= 6000) base = 10;
      else if (estimatedBytes >= 2500) base = 8;

      const complexitySignals =
        (this.topic.trim() ? 1 : 0) +
        (this.title.trim() ? 1 : 0) +
        (this.description.trim() ? 1 : 0) +
        Math.min(3, youtubeCount);
      return this.clampQuestionCount(base + complexitySignals);
    },
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
            questionCount: this.autoQuestionCount ? undefined : this.questionCount
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
    attemptFinished: false,
    chatMessages: [],
    chatInput: "",
    chatLoading: false,
    chatError: "",
    initPromise: null,
    get currentQuestion() {
      return this.quiz.questions[this.index];
    },
    async init() {
      if (this.initPromise) {
        return this.initPromise;
      }
      this.initPromise = this.initializeQuiz();
      return this.initPromise;
    },
    async initializeQuiz() {
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
    async sendChatMessage() {
      if (!this.attemptId || !this.currentQuestion || this.chatLoading || this.attemptFinished) return;
      const trimmed = this.chatInput.trim();
      if (!trimmed) return;

      this.chatError = "";
      this.chatLoading = true;
      this.chatMessages.push({
        role: "user",
        content: trimmed
      });
      this.chatInput = "";

      try {
        const result = await jsonFetch(`/api/attempts/${encodeURIComponent(this.attemptId)}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            questionId: this.currentQuestion.id,
            questionIndex: this.index
          })
        });
        this.chatMessages.push({
          role: "assistant",
          content: result.reply || "I could not generate a response right now."
        });
      } catch (error) {
        this.chatError = error.message;
      } finally {
        this.chatLoading = false;
      }
    },
    async finishAttempt() {
      if (!this.attemptId) return;
      try {
        await jsonFetch(`/api/attempts/${encodeURIComponent(this.attemptId)}/finish`, {
          method: "POST"
        });
        this.attemptFinished = true;
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

window.dashboardPage = function dashboardPage() {
  const FILTER_STORAGE_KEY = "dashboardFilters";

  return {
    filters: {
      range: "30d",
      quizId: ""
    },
    status: "Loading dashboard...",
    overview: {
      totalQuizzes: 0,
      totalAttempts: 0,
      completionRate: 0,
      averageScore: 0,
      latestScoreTrend: 0
    },
    quizzes: [],
    learning: {
      weakAreas: [],
      questionTypeAccuracy: [],
      retakeImprovement: []
    },
    availableQuizzes: [],
    quizCatalog: [],
    troubleMode: "reuse_exact",
    troubleQuestionCount: 8,
    troubleLoading: false,
    troubleStatus: "",
    previewQuiz: null,
    previewOpen: false,
    chartInstances: {},
    async init() {
      this.restoreFilters();
      await this.refreshAll();
    },
    restoreFilters() {
      try {
        const raw = localStorage.getItem(FILTER_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.range === "string") this.filters.range = parsed.range;
          if (typeof parsed.quizId === "string") this.filters.quizId = parsed.quizId;
        }
      } catch {
        // Ignore malformed localStorage payloads.
      }
    },
    persistFilters() {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(this.filters));
    },
    setQuickRange(range) {
      this.filters.range = range;
      this.refreshAll();
    },
    resetFilters() {
      this.filters.range = "30d";
      this.filters.quizId = "";
      this.refreshAll();
    },
    queryString() {
      const params = new URLSearchParams();
      params.set("range", this.filters.range);
      if (this.filters.quizId) params.set("quizId", this.filters.quizId);
      return params.toString();
    },
    chartTextColor() {
      return "#d4d4d4";
    },
    axisColor() {
      return "#525252";
    },
    afterDomPaint() {
      return new Promise((resolve) => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(resolve);
        });
      });
    },
    destroyChart(key) {
      if (this.chartInstances[key]) {
        this.chartInstances[key].destroy();
        delete this.chartInstances[key];
      }
    },
    safeChartRender(key, renderFn) {
      try {
        renderFn();
      } catch (error) {
        // Keep other charts rendering even if one chart fails.
        console.error(`[Dashboard] Failed to render chart: ${key}`, error);
      }
    },
    renderLineChart(canvasId, key, labels, data, color, label) {
      if (!window.Chart) return;
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      this.destroyChart(key);
      this.chartInstances[key] = new window.Chart(context, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label,
              data,
              borderColor: color,
              backgroundColor: color,
              tension: 0.25
            }
          ]
        },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              ticks: { color: this.chartTextColor() },
              grid: { color: this.axisColor() }
            },
            y: {
              beginAtZero: true,
              ticks: { color: this.chartTextColor() },
              grid: { color: this.axisColor() }
            }
          },
          plugins: {
            legend: {
              labels: { color: this.chartTextColor() }
            }
          }
        }
      });
    },
    renderBarChart(canvasId, key, labels, data, color, label) {
      if (!window.Chart) return;
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      this.destroyChart(key);
      this.chartInstances[key] = new window.Chart(context, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label,
              data,
              backgroundColor: color
            }
          ]
        },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              ticks: { color: this.chartTextColor() },
              grid: { color: this.axisColor() }
            },
            y: {
              beginAtZero: true,
              ticks: { color: this.chartTextColor() },
              grid: { color: this.axisColor() }
            }
          },
          plugins: {
            legend: {
              labels: { color: this.chartTextColor() }
            }
          }
        }
      });
    },
    renderDoughnutChart(canvasId, key, labels, data) {
      if (!window.Chart) return;
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      this.destroyChart(key);
      this.chartInstances[key] = new window.Chart(context, {
        type: "doughnut",
        data: {
          labels,
          datasets: [
            {
              data,
              backgroundColor: ["#22c55e", "#16a34a", "#15803d", "#166534", "#86efac"]
            }
          ]
        },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              labels: { color: this.chartTextColor() }
            }
          }
        }
      });
    },
    renderCharts(attemptsOverTime) {
      const labels = attemptsOverTime.map((point) => point.date);
      const attemptCounts = attemptsOverTime.map((point) => point.attempts);
      const averageScores = attemptsOverTime.map((point) => point.avgScore);

      this.safeChartRender("attemptsChart", () => {
        this.renderLineChart("attemptsChart", "attemptsChart", labels, attemptCounts, "#22c55e", "Attempts");
      });
      this.safeChartRender("scoreChart", () => {
        this.renderLineChart("scoreChart", "scoreChart", labels, averageScores, "#4ade80", "Avg Score %");
      });

      const accuracyLabels = this.learning.questionTypeAccuracy.map((item) => item.type);
      const accuracyValues = this.learning.questionTypeAccuracy.map((item) => item.averageScore);
      this.safeChartRender("accuracyChart", () => {
        this.renderDoughnutChart("accuracyChart", "accuracyChart", accuracyLabels, accuracyValues);
      });

      const retakeLabels = this.learning.retakeImprovement.map((item) => item.quizTitle);
      const retakeValues = this.learning.retakeImprovement.map((item) => item.trendDelta);
      this.safeChartRender("retakeChart", () => {
        this.renderBarChart("retakeChart", "retakeChart", retakeLabels, retakeValues, "#16a34a", "Trend Delta %");
      });
    },
    async refreshAll() {
      this.status = "Refreshing dashboard analytics...";
      this.persistFilters();
      try {
        const query = this.queryString();
        const [overviewPayload, quizzesPayload, learningPayload] = await Promise.all([
          jsonFetch(`/api/analytics/overview?${query}`),
          jsonFetch(`/api/analytics/quizzes?${query}`),
          jsonFetch(`/api/analytics/learning?${query}`)
        ]);

        this.overview = overviewPayload.overview;
        this.availableQuizzes = overviewPayload.availableQuizzes || [];
        this.quizzes = quizzesPayload.quizzes || [];
        this.learning = learningPayload.learning || {
          weakAreas: [],
          questionTypeAccuracy: [],
          retakeImprovement: []
        };

        await this.afterDomPaint();
        this.renderCharts(overviewPayload.charts?.attemptsOverTime || []);
        await this.loadQuizCatalog();
        this.status = "Dashboard updated.";
      } catch (error) {
        this.status = error.message;
      }
    },
    async loadQuizCatalog() {
      const payload = await jsonFetch("/api/quizzes");
      this.quizCatalog = payload.quizzes || [];
    },
    startQuiz(quizId) {
      window.location.href = `/quiz?quizId=${encodeURIComponent(quizId)}`;
    },
    async openQuizPreview(quizId) {
      const payload = await jsonFetch(`/api/quizzes/${encodeURIComponent(quizId)}`);
      this.previewQuiz = payload;
      this.previewOpen = true;
    },
    async deleteQuiz(quizId, quizTitle) {
      const confirmed = window.confirm(`Delete quiz "${quizTitle || "Untitled Quiz"}"? This cannot be undone.`);
      if (!confirmed) return;
      this.status = "Deleting quiz...";
      try {
        await jsonFetch(`/api/quizzes/${encodeURIComponent(quizId)}`, {
          method: "DELETE"
        });
        if (this.previewQuiz?.id === quizId) {
          this.closeQuizPreview();
        }
        await this.loadQuizCatalog();
        this.status = "Quiz deleted.";
      } catch (error) {
        this.status = error.message;
      }
    },
    closeQuizPreview() {
      this.previewOpen = false;
      this.previewQuiz = null;
    },
    downloadCsv() {
      const query = this.queryString();
      window.location.href = `/api/analytics/export.csv?${query}`;
    },
    async startTroubleQuiz() {
      if (this.troubleLoading) return;
      this.troubleLoading = true;
      this.troubleStatus = "Creating your trouble quiz...";
      try {
        const payload = await jsonFetch("/api/quizzes/custom/trouble", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: this.troubleMode,
            questionCount: Number(this.troubleQuestionCount) || undefined
          })
        });
        this.troubleStatus = "Trouble quiz ready. Redirecting...";
        window.location.href = `/quiz?quizId=${encodeURIComponent(payload.quizId)}`;
      } catch (error) {
        this.troubleStatus = error.message;
      } finally {
        this.troubleLoading = false;
      }
    }
  };
};
