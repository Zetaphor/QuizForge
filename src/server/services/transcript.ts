import { execFile } from "node:child_process";
import { promisify } from "node:util";

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
const execFileAsync = promisify(execFile);

export function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (VIDEO_ID_REGEX.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname)) {
    return null;
  }

  if (url.hostname === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id && VIDEO_ID_REGEX.test(id) ? id : null;
  }

  const queryId = url.searchParams.get("v");
  if (queryId && VIDEO_ID_REGEX.test(queryId)) return queryId;

  const segments = url.pathname.split("/").filter(Boolean);
  const markers = ["embed", "shorts", "live", "v"];
  const markerIndex = segments.findIndex((segment) => markers.includes(segment));
  if (markerIndex >= 0) {
    const id = segments[markerIndex + 1];
    return id && VIDEO_ID_REGEX.test(id) ? id : null;
  }

  return null;
}

function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseTimeToSeconds(raw: string): number {
  const trimmed = raw.trim().replace(",", ".");
  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] ?? 0;
}

function stripSubtitleMarkup(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJson3Transcript(content: string): Array<{ seconds: number; text: string }> {
  const data = JSON.parse(content) as {
    events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }>;
  };
  const events = data.events ?? [];
  return events
    .map((event) => {
      const text = (event.segs ?? [])
        .map((seg) => seg.utf8 ?? "")
        .join("")
        .replace(/\n/g, " ");
      return {
        seconds: (event.tStartMs ?? 0) / 1000,
        text: stripSubtitleMarkup(text)
      };
    })
    .filter((item) => item.text.length > 0);
}

function parseVttTranscript(content: string): Array<{ seconds: number; text: string }> {
  const lines = content.split(/\r?\n/);
  const result: Array<{ seconds: number; text: string }> = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line.startsWith("WEBVTT") || /^\d+$/.test(line)) {
      i += 1;
      continue;
    }

    if (line.includes("-->")) {
      const [start] = line.split("-->");
      const textLines: string[] = [];
      i += 1;
      while (i < lines.length && lines[i].trim()) {
        textLines.push(lines[i].trim());
        i += 1;
      }
      const text = stripSubtitleMarkup(textLines.join(" "));
      if (text) {
        result.push({
          seconds: parseTimeToSeconds(start),
          text
        });
      }
      continue;
    }

    i += 1;
  }

  return result;
}

function parseTtmlTranscript(content: string): Array<{ seconds: number; text: string }> {
  const matches = [...content.matchAll(/<p\b[^>]*begin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/gi)];
  return matches
    .map((match) => ({
      seconds: parseTimeToSeconds(match[1] ?? "0"),
      text: stripSubtitleMarkup(match[2] ?? "")
    }))
    .filter((item) => item.text.length > 0);
}

type CaptionTrack = { ext?: string; url?: string; name?: string };

function selectCaptionTrack(
  tracksByLang: Record<string, CaptionTrack[]>,
  preferredLang?: string
): CaptionTrack | null {
  const entries = Object.entries(tracksByLang);
  if (!entries.length) return null;

  const lang = (preferredLang ?? "").toLowerCase();
  const rankTracks = (tracks: CaptionTrack[]) => {
    const formatOrder = ["json3", "vtt", "ttml", "srv3", "srv2", "srv1"];
    return [...tracks].sort((a, b) => {
      const aRank = formatOrder.indexOf((a.ext ?? "").toLowerCase());
      const bRank = formatOrder.indexOf((b.ext ?? "").toLowerCase());
      const safeARank = aRank === -1 ? 999 : aRank;
      const safeBRank = bRank === -1 ? 999 : bRank;
      return safeARank - safeBRank;
    });
  };

  if (lang) {
    const exact = entries.find(([key]) => key.toLowerCase() === lang)?.[1];
    if (exact?.length) return rankTracks(exact)[0];

    const prefix = entries.find(([key]) => key.toLowerCase().startsWith(lang))?.[1];
    if (prefix?.length) return rankTracks(prefix)[0];
  }

  for (const [, tracks] of entries) {
    if (!tracks.length) continue;
    const filtered = tracks.filter((track) => !(track.name ?? "").toLowerCase().includes("live chat"));
    const candidates = filtered.length ? filtered : tracks;
    if (candidates.length) return rankTracks(candidates)[0];
  }

  return null;
}

async function fetchTranscriptViaYtDlp(videoUrl: string, preferredLang = "en"): Promise<Array<{ seconds: number; text: string }>> {
  let stdout: string;
  try {
    const result = await execFileAsync("yt-dlp", ["--dump-single-json", "--no-warnings", videoUrl], {
      maxBuffer: 15 * 1024 * 1024
    });
    stdout = result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      throw new Error("YT_DLP_NOT_INSTALLED");
    }
    throw new Error(`YT_DLP_FAILED: ${message}`);
  }

  const metadata = JSON.parse(stdout) as {
    subtitles?: Record<string, CaptionTrack[]>;
    automatic_captions?: Record<string, CaptionTrack[]>;
  };

  const manualTrack = selectCaptionTrack(metadata.subtitles ?? {}, preferredLang);
  const autoTrack = selectCaptionTrack(metadata.automatic_captions ?? {}, preferredLang);
  const selected = manualTrack ?? autoTrack;
  if (!selected?.url) {
    throw new Error("NO_TRANSCRIPT_AVAILABLE");
  }

  const response = await fetch(selected.url);
  if (!response.ok) {
    throw new Error(`TRANSCRIPT_FETCH_FAILED_${response.status}`);
  }
  const raw = await response.text();
  const ext = (selected.ext ?? "").toLowerCase();

  if (ext === "json3") {
    return parseJson3Transcript(raw);
  }

  if (ext === "ttml") {
    return parseTtmlTranscript(raw);
  }

  return parseVttTranscript(raw);
}

export async function getYouTubeTranscript(input: string, lang = "en"): Promise<{
  videoId: string;
  transcriptText: string;
}> {
  const videoId = extractVideoId(input);
  if (!videoId) {
    throw new Error("Invalid YouTube URL or video ID.");
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const entries = await fetchTranscriptViaYtDlp(videoUrl, lang);
  const transcriptText = entries
    .map((entry) => `[${formatTimestamp(entry.seconds)}] ${entry.text}`)
    .join("\n");

  if (!transcriptText.trim()) {
    throw new Error("NO_TRANSCRIPT_AVAILABLE");
  }

  return { videoId, transcriptText };
}
