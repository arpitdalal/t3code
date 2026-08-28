import { describe, expect, it } from "@effect/vitest";

import {
  buildKiroEffortExecuteParams,
  buildKiroEffortOptionsParams,
  normalizeKiroMetadataUsage,
  normalizeKiroPromptResponseUsage,
  normalizeKiroSlashCommandName,
  normalizeKiroUsageUpdate,
  parseKiroAvailableCommands,
  parseKiroEffortCommandOptions,
} from "./KiroAcpCommands.ts";

describe("normalizeKiroSlashCommandName", () => {
  it("strips a leading slash and trims", () => {
    expect(normalizeKiroSlashCommandName("/agent")).toBe("agent");
    expect(normalizeKiroSlashCommandName("  /model  ")).toBe("model");
    expect(normalizeKiroSlashCommandName("help")).toBe("help");
    expect(normalizeKiroSlashCommandName("   ")).toBeUndefined();
    expect(normalizeKiroSlashCommandName("/")).toBeUndefined();
  });
});

describe("parseKiroAvailableCommands", () => {
  it("maps Kiro ACP commands into ServerProviderSlashCommand entries", () => {
    expect(
      parseKiroAvailableCommands([
        {
          name: "/agent",
          description: "Select or list available agents",
          meta: { hint: "" },
        },
        {
          name: "/context",
          description: "Manage context files",
          meta: { hint: "add <path>, remove <path>" },
        },
        {
          name: "/agent",
          description: "duplicate ignored for description when first wins",
        },
      ]),
    ).toEqual([
      {
        name: "agent",
        description: "Select or list available agents",
      },
      {
        name: "context",
        description: "Manage context files",
        input: { hint: "add <path>, remove <path>" },
      },
    ]);
  });
});

describe("parseKiroEffortCommandOptions", () => {
  it("parses effort options and strips the active marker", () => {
    expect(
      parseKiroEffortCommandOptions({
        options: [
          { value: "low", label: "low" },
          { value: "high", label: "high  [active]" },
          { value: "max", label: "max" },
        ],
        hasMore: false,
      }),
    ).toEqual([
      { value: "low", label: "low", isActive: false },
      { value: "high", label: "high", isActive: true },
      { value: "max", label: "max", isActive: false },
    ]);
  });

  it("returns an empty list for malformed payloads", () => {
    expect(parseKiroEffortCommandOptions(null)).toEqual([]);
    expect(parseKiroEffortCommandOptions({ options: "nope" })).toEqual([]);
  });
});

describe("buildKiroEffort params", () => {
  it("builds execute and options payloads", () => {
    expect(buildKiroEffortExecuteParams({ sessionId: "sess", effort: "max" })).toEqual({
      sessionId: "sess",
      command: { command: "effort", args: ["max"] },
    });
    expect(buildKiroEffortOptionsParams({ sessionId: "sess" })).toEqual({
      sessionId: "sess",
      command: "effort",
      partialInput: "",
    });
  });
});

describe("normalizeKiroUsageUpdate", () => {
  it("converts ACP usage_update into a ThreadTokenUsageSnapshot", () => {
    expect(
      normalizeKiroUsageUpdate({
        used: 1500,
        size: 200_000,
      }),
    ).toEqual({
      usedTokens: 1500,
      lastUsedTokens: 1500,
      maxTokens: 200_000,
      compactsAutomatically: true,
    });
  });

  it("preserves last known context window when size is omitted", () => {
    expect(normalizeKiroUsageUpdate({ used: 2500 }, { lastKnownContextWindow: 200_000 })).toEqual({
      usedTokens: 2500,
      lastUsedTokens: 2500,
      maxTokens: 200_000,
      compactsAutomatically: true,
    });
  });
});

describe("normalizeKiroMetadataUsage", () => {
  it("converts contextUsagePercentage into token usage using known or default max tokens", () => {
    expect(
      normalizeKiroMetadataUsage(
        {
          sessionId: "sess",
          contextUsagePercentage: 42.5,
          turnDurationMs: 1200,
        },
        { lastKnownContextWindow: 200_000 },
      ),
    ).toEqual({
      usedTokens: 85_000,
      lastUsedTokens: 85_000,
      maxTokens: 200_000,
      durationMs: 1200,
      compactsAutomatically: true,
    });
  });

  it("handles explicit usedTokens and maxTokens in metadata if provided", () => {
    expect(
      normalizeKiroMetadataUsage({
        sessionId: "sess",
        usedTokens: 3400,
        maxTokens: 128_000,
      }),
    ).toEqual({
      usedTokens: 3400,
      lastUsedTokens: 3400,
      maxTokens: 128_000,
      compactsAutomatically: true,
    });
  });

  it("returns undefined for invalid or empty metadata", () => {
    expect(normalizeKiroMetadataUsage(null)).toBeUndefined();
    expect(normalizeKiroMetadataUsage({})).toBeUndefined();
  });
});

describe("normalizeKiroPromptResponseUsage", () => {
  it("converts prompt response usage payload into ThreadTokenUsageSnapshot", () => {
    expect(
      normalizeKiroPromptResponseUsage(
        {
          inputTokens: 1000,
          outputTokens: 250,
          totalTokens: 1250,
          cachedReadTokens: 400,
          thoughtTokens: 100,
        },
        { lastKnownContextWindow: 200_000 },
      ),
    ).toEqual({
      usedTokens: 1250,
      lastUsedTokens: 1250,
      totalProcessedTokens: 1250,
      maxTokens: 200_000,
      inputTokens: 1000,
      lastInputTokens: 1000,
      outputTokens: 250,
      lastOutputTokens: 250,
      cachedInputTokens: 400,
      lastCachedInputTokens: 400,
      reasoningOutputTokens: 100,
      lastReasoningOutputTokens: 100,
      compactsAutomatically: true,
    });
  });
});
