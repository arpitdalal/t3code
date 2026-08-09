/**
 * Kiro ACP slash-command helpers.
 *
 * Kiro advertises slash commands via the `_kiro.dev/commands/available`
 * extension notification after `session/new`. Names arrive with a leading
 * `/` (e.g. `/agent`); T3's composer prepends `/` when inserting, so we
 * normalize to the bare name for `ServerProviderSlashCommand`.
 *
 * @module provider/acp/KiroAcpCommands
 */
import type { ServerProviderSlashCommand } from "@t3tools/contracts";
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
