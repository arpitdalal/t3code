/**
 * KiroSkills — filesystem discovery of Kiro CLI skills for the `$` picker.
 *
 * Kiro loads skills from `~/.kiro/skills` (user scope) and `<cwd>/.kiro/skills`
 * (project scope), one directory (or symlink) per skill with a `SKILL.md`
 * carrying YAML frontmatter — the same layout Claude Code uses.
 *
 * @module provider/Drivers/KiroSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

type KiroSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

export const resolveKiroHomeDirPath = Effect.fn("resolveKiroHomeDirPath")(function* (
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const environmentHome = environment.KIRO_HOME?.trim() ?? "";
  if (environmentHome.length > 0) {
    return cwd ? path.resolve(cwd, environmentHome) : path.resolve(environmentHome);
  }
  return path.join(NodeOS.homedir(), ".kiro");
});

/**
 * Enumerate Kiro skills from the user home dir and the workspace.
 * Discovery is best-effort: unreadable roots and malformed skill entries are
 * skipped. On name collisions the project-scoped skill wins.
 */
export const discoverKiroSkills = Effect.fn("discoverKiroSkills")(function* (
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirPath = yield* resolveKiroHomeDirPath(environment ?? process.env, cwd);

  const roots: ReadonlyArray<{ directory: string; scope: KiroSkillScope }> = [
    { directory: path.join(homeDirPath, "skills"), scope: "user" },
    ...(cwd ? [{ directory: path.join(cwd, ".kiro", "skills"), scope: "project" as const }] : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!name) {
        continue;
      }

      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
