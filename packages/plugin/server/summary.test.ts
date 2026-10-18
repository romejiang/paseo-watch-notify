import { describe, expect, test } from "vitest";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import {
  buildFinishedPreview,
  buildPermissionPreview,
  latestAssistantMessage,
  stripMarkdownToText,
} from "./summary";

type Timeline = PluginLifecycleEvents["agent.turn_ended"]["timeline"];
type PermissionRequest = PluginLifecycleEvents["agent.permission_requested"]["request"];

function timeline(items: unknown[]): Timeline {
  return items as Timeline;
}

describe("latestAssistantMessage", () => {
  test("joins trailing assistant chunks split across items", () => {
    const text = latestAssistantMessage(
      timeline([
        { type: "user_message", text: "Please fix it" },
        { type: "assistant_message", text: "Working" },
        { type: "assistant_message", text: " on it." },
      ]),
    );
    expect(text).toBe("Working on it.");
  });

  test("skips trailing non-text items after the last assistant message", () => {
    const text = latestAssistantMessage(
      timeline([
        { type: "assistant_message", text: "Done." },
        { type: "error", message: "noise" },
      ]),
    );
    expect(text).toBe("Done.");
  });

  test("returns null without any assistant message", () => {
    expect(latestAssistantMessage(timeline([{ type: "user_message", text: "hi" }]))).toBeNull();
  });
});

describe("stripMarkdownToText", () => {
  test("removes structural and inline markers but keeps content", () => {
    const stripped = stripMarkdownToText(
      "# Title\n\n- item **bold** and `code`\n\n[link](https://example.com)\n```\nblock\n```",
    );
    expect(stripped).toContain("Title");
    expect(stripped).toContain("bold and code");
    expect(stripped).toContain("link");
    expect(stripped).toContain("block");
    expect(stripped).not.toContain("**");
    expect(stripped).not.toContain("```");
  });
});

describe("buildFinishedPreview", () => {
  test("normalizes whitespace, strips markdown and truncates", () => {
    const preview = buildFinishedPreview(
      timeline([{ type: "assistant_message", text: "**Done**   with\n\n the work." }]),
    );
    expect(preview).toBe("Done with the work.");
  });

  test("truncates long previews to the limit", () => {
    const long = "a".repeat(400);
    const preview = buildFinishedPreview(timeline([{ type: "assistant_message", text: long }]));
    expect(preview).not.toBeNull();
    expect(preview!.length).toBeLessThanOrEqual(220);
    expect(preview!.endsWith("...")).toBe(true);
  });
});

describe("buildPermissionPreview", () => {
  test("prefers title and description", () => {
    const preview = buildPermissionPreview({
      id: "p1",
      provider: "claude",
      name: "Bash",
      kind: "tool",
      title: "Run command",
      description: "git status",
    } as unknown as PermissionRequest);
    expect(preview).toBe("Run command - git status");
  });

  test("falls back to the request input JSON", () => {
    const preview = buildPermissionPreview({
      id: "p1",
      provider: "claude",
      name: "Bash",
      kind: "tool",
      input: { command: "rm -rf build" },
    } as unknown as PermissionRequest);
    expect(preview).toContain("rm -rf build");
  });
});
