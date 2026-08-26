/**
 * Kiro ACP slash-command helpers.
 *
 * Kiro advertises slash commands via the `_kiro.dev/commands/available`
 * extension notification after `session/new`. Names arrive with a leading
 * `/` (e.g. `/agent`); T3's composer prepends `/` when inserting, so we
 * normalize to the bare name for `ServerProviderSlashCommand`.
 *
 * Effort levels for the active model are discovered through
 * `_kiro.dev/commands/options` (`command: "effort"`) and applied with
 * `_kiro.dev/commands/execute`.
 *
 * @module provider/acp/KiroAcpCommands
 */
import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const KiroAvailableCommandMeta = Schema.Struct({
  hint: Schema.optional(Schema.String),
});

const KiroAvailableCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  meta: Schema.optional(KiroAvailableCommandMeta),
});

export const KiroCommandsAvailableNotification = Schema.Struct({
  sessionId: Schema.String,
  commands: Schema.Array(KiroAvailableCommand),
});

export type KiroCommandsAvailableNotification = typeof KiroCommandsAvailableNotification.Type;

export const KIRO_COMMANDS_AVAILABLE_METHOD = "_kiro.dev/commands/available";
export const KIRO_COMMANDS_OPTIONS_METHOD = "_kiro.dev/commands/options";
export const KIRO_COMMANDS_EXECUTE_METHOD = "_kiro.dev/commands/execute";
export const KIRO_EFFORT_COMMAND = "effort";
export const KIRO_EFFORT_OPTION_ID = "effort";

const KiroCommandOption = Schema.Struct({
  value: Schema.String,
  label: Schema.optional(Schema.String),
});

export const KiroCommandsOptionsResponse = Schema.Struct({
  options: Schema.Array(KiroCommandOption),
  hasMore: Schema.optional(Schema.Boolean),
});

export type KiroCommandsOptionsResponse = typeof KiroCommandsOptionsResponse.Type;

export interface KiroEffortCommandOption {
  readonly value: string;
  readonly label: string;
  readonly isActive: boolean;
}

const ACTIVE_OPTION_LABEL_SUFFIX = /\s*\[active\]\s*$/iu;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Strip a single leading `/` so the composer does not render `//agent`. */
export function normalizeKiroSlashCommandName(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1).trim() : trimmed;
  return withoutSlash.length > 0 ? withoutSlash : undefined;
}

export function parseKiroAvailableCommands(
  commands: KiroCommandsAvailableNotification["commands"],
): ReadonlyArray<ServerProviderSlashCommand> {
  const byName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = normalizeKiroSlashCommandName(command.name);
    if (!name) continue;

    const description = nonEmpty(command.description);
    const hint = nonEmpty(command.meta?.hint);
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      });
      continue;
    }

    byName.set(key, {
      ...existing,
      ...(existing.description ? {} : description ? { description } : {}),
      ...(existing.input?.hint ? {} : hint ? { input: { hint } } : {}),
    });
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Parse `_kiro.dev/commands/options` for `/effort`, stripping the `[active]` marker. */
export function parseKiroEffortCommandOptions(
  response: unknown,
): ReadonlyArray<KiroEffortCommandOption> {
  const decoded = Schema.decodeUnknownExit(KiroCommandsOptionsResponse)(response);
  if (Exit.isFailure(decoded)) {
    return [];
  }

  const seen = new Set<string>();
  const options: Array<KiroEffortCommandOption> = [];
  for (const option of decoded.value.options) {
    const value = option.value.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const rawLabel = option.label?.trim() || value;
    const isActive = ACTIVE_OPTION_LABEL_SUFFIX.test(rawLabel);
    const label = rawLabel.replace(ACTIVE_OPTION_LABEL_SUFFIX, "").trim() || value;
    options.push({ value, label, isActive });
  }
  return options;
}

export function buildKiroEffortExecuteParams(input: {
  readonly sessionId: string;
  readonly effort: string;
}) {
  return {
    sessionId: input.sessionId,
    command: {
      command: KIRO_EFFORT_COMMAND,
      args: [input.effort],
    },
  };
}

export function buildKiroEffortOptionsParams(input: {
  readonly sessionId: string;
  readonly partialInput?: string;
}) {
  return {
    sessionId: input.sessionId,
    command: KIRO_EFFORT_COMMAND,
    partialInput: input.partialInput ?? "",
  };
}
