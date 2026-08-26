import { describe, expect, it } from "@effect/vitest";

import {
  buildKiroEffortExecuteParams,
  buildKiroEffortOptionsParams,
  normalizeKiroSlashCommandName,
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
