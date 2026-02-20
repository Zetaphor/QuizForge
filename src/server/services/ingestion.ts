import crypto from "node:crypto";

export type NormalizedSource = {
  origin: "markdown" | "youtube";
  title: string;
  externalRef?: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function normalizeMarkdownSource(name: string, content: string): NormalizedSource {
  const cleaned = content.trim();
  if (!cleaned) {
    throw new Error(`Markdown file ${name} is empty.`);
  }

  return {
    origin: "markdown",
    title: name,
    content: cleaned,
    metadata: {
      length: cleaned.length
    }
  };
}

export function normalizeYouTubeSource(videoId: string, transcriptText: string): NormalizedSource {
  const cleaned = transcriptText.trim();
  if (!cleaned) {
    throw new Error("Transcript is empty.");
  }

  return {
    origin: "youtube",
    title: `YouTube Transcript (${videoId})`,
    externalRef: `https://www.youtube.com/watch?v=${videoId}`,
    content: cleaned,
    metadata: {
      videoId,
      length: cleaned.length
    }
  };
}
