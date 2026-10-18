import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";

type TurnEndedTimeline = PluginLifecycleEvents["agent.turn_ended"]["timeline"];
type PermissionRequest = PluginLifecycleEvents["agent.permission_requested"]["request"];

const PREVIEW_LIMIT = 220;

/** Whitespace-normalize text the same way Paseo's own attention notifications do. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const trimmed = text.slice(0, Math.max(0, limit - 3)).trimEnd();
  return trimmed.length > 0 ? `${trimmed}...` : text.slice(0, limit);
}

/**
 * Lightweight markdown-to-text pass so a push body reads cleanly on a watch face. This is a
 * pragmatic subset, not a full CommonMark renderer.
 */
export function stripMarkdownToText(markdown: string): string {
  let text = markdown.replace(/\r\n/g, "\n");

  // Keep code content, drop the fences.
  text = text.replace(/^\s*```[^\n]*$/gm, "");
  text = text.replace(/^\s*~~~[^\n]*$/gm, "");

  // Links and images keep their label.
  text = text.replace(/!\[([^\]]*)\]\((?:[^()\\]|\\.)*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\((?:[^()\\]|\\.)*\)/g, "$1");

  // Structural prefixes.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>+\s?/gm, "");
  text = text.replace(/^\s{0,3}(?:[*+-]|\d+\.)\s+/gm, "");
  text = text.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, "");

  // Inline markers.
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/_([^_\n]+)_/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");

  // Angle-bracketed autolinks.
  text = text.replace(/<([^>\n]+)>/g, "$1");

  return text;
}

/**
 * Join the trailing run of `assistant_message` chunks. Trailing non-text items (tool calls, etc.)
 * are skipped so the summary reflects the last thing the agent actually said.
 */
export function latestAssistantMessage(timeline: TurnEndedTimeline): string | null {
  const chunks: string[] = [];
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i];
    if (item.type === "assistant_message") {
      chunks.push(item.text);
      continue;
    }
    if (chunks.length > 0) {
      break;
    }
  }
  if (chunks.length === 0) {
    return null;
  }
  return chunks.reverse().join("");
}

function buildPreview(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }
  const normalized = normalizeText(stripMarkdownToText(text));
  if (!normalized) {
    return null;
  }
  return truncateText(normalized, PREVIEW_LIMIT);
}

export function buildFinishedPreview(timeline: TurnEndedTimeline): string | null {
  return buildPreview(latestAssistantMessage(timeline));
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function buildPermissionPreview(request: PermissionRequest): string | null {
  const title = request.title?.trim();
  const description = request.description?.trim();
  const details: string[] = [];
  if (title) {
    details.push(title);
  }
  if (description && description !== title) {
    details.push(description);
  }
  if (details.length > 0) {
    return buildPreview(details.join(" - "));
  }

  const inputPreview = request.input ? safeStringify(request.input) : null;
  if (inputPreview) {
    return buildPreview(inputPreview);
  }

  const metadataPreview = request.metadata ? safeStringify(request.metadata) : null;
  if (metadataPreview) {
    return buildPreview(metadataPreview);
  }

  return buildPreview(request.name?.trim() || request.kind);
}
