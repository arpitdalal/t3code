import { describe, expect, it } from "@effect/vitest";

import { normalizeKiroSlashCommandName, parseKiroAvailableCommands } from "./KiroAcpCommands.ts";

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
