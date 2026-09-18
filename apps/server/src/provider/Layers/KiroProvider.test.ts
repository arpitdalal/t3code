import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { KiroSettings } from "@t3tools/contracts";

import {
  buildInitialKiroProviderSnapshot,
  checkKiroProviderStatus,
  withKiroCompactSlashCommand,
} from "./KiroProvider.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

describe("withKiroCompactSlashCommand", () => {
  it("always prepends canonical compact", () => {
    expect(withKiroCompactSlashCommand([]).map((command) => command.name)).toEqual(["compact"]);
    expect(
      withKiroCompactSlashCommand([{ name: "agent", description: "Switch agent" }]).map(
        (command) => command.name,
      ),
    ).toEqual(["compact", "agent"]);
  });

  it("normalizes ACP Compact casing to compact", () => {
    expect(
      withKiroCompactSlashCommand([
        { name: "Compact", description: "Kiro native compact" },
        { name: "agent" },
      ]),
    ).toEqual([{ name: "compact", description: "Kiro native compact" }, { name: "agent" }]);
  });
});

describe("buildInitialKiroProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(
        decodeKiroSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
      expect(snapshot.slashCommands).toEqual([]);
    }),
  );

  it.effect("returns a pending snapshot with /compact available", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(decodeKiroSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Kiro");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact"]);
    }),
  );
});

it.layer(NodeServices.layer)("checkKiroProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKiroProviderStatus(
        decodeKiroSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/kiro-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
      expect(snapshot.slashCommands).toEqual([]);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken kiro install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kiro-version-" });
          const kiroPath = path.join(dir, "kiro");
          yield* fs.writeFileString(
            kiroPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(kiroPath, 0o755);

          return yield* checkKiroProviderStatus(
            decodeKiroSettings({ enabled: true, binaryPath: kiroPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Kiro CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact"]);
    }),
  );

  it.effect("keeps /compact when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kiro-success-" });
          const kiroPath = path.join(dir, "kiro");
          yield* fs.writeFileString(
            kiroPath,
            ["#!/bin/sh", 'printf "kiro-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(kiroPath, 0o755);

          return yield* checkKiroProviderStatus(
            decodeKiroSettings({ enabled: true, binaryPath: kiroPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
      expect(snapshot.message).toContain("ACP startup failed");
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact"]);
    }),
  );
});
