import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverKiroSkills } from "./KiroSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverKiroSkills", (it) => {
  it.effect("discovers user and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-skills-" });
      const homeDir = path.join(tempDir, "kiro-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(homeDir, "skills"),
        "code-review",
        [
          "---",
          "name: code-review",
          "description: Review changes since a fixed point.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".kiro", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      );

      const skills = yield* discoverKiroSkills(workspace, { KIRO_HOME: homeDir });

      assert.deepEqual(skills, [
        {
          name: "code-review",
          path: path.join(homeDir, "skills", "code-review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Review changes since a fixed point.",
        },
        {
          name: "deploy",
          path: path.join(workspace, ".kiro", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Deploy the app.",
        },
      ]);
    }),
  );

  it.effect("prefers project skills over user skills on name collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-skills-" });
      const homeDir = path.join(tempDir, "kiro-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(homeDir, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".kiro", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project deploy.", "---"].join("\n"),
      );

      const skills = yield* discoverKiroSkills(workspace, { KIRO_HOME: homeDir });
      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.description, "Project deploy.");
      assert.equal(skills[0]?.scope, "project");
    }),
  );

  it.effect("follows symlinked skill directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-skills-" });
      const homeDir = path.join(tempDir, "kiro-home");
      const sharedSkills = path.join(tempDir, "shared-skills");
      const linkName = "linked-review";

      yield* writeSkill(
        sharedSkills,
        linkName,
        ["---", "name: linked-review", "description: Via symlink.", "---"].join("\n"),
      );
      yield* fs.makeDirectory(path.join(homeDir, "skills"), { recursive: true });
      yield* fs.symlink(path.join(sharedSkills, linkName), path.join(homeDir, "skills", linkName));

      const skills = yield* discoverKiroSkills(undefined, { KIRO_HOME: homeDir });
      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.name, "linked-review");
      assert.equal(skills[0]?.description, "Via symlink.");
    }),
  );
});
