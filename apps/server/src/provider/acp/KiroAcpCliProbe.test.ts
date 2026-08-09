/**
 * Optional integration check against a real `kiro-cli acp` install.
 * Enable with: T3_KIRO_ACP_PROBE=1 bun run test KiroAcpCliProbe
 *
 * Assumes the user has previously run `kiro-cli login`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeKiroAcpRuntime } from "./KiroAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeKiroAcpRuntime({
    kiroSettings: { binaryPath: "kiro-cli" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-kiro-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_KIRO_ACP_PROBE === "1")("Kiro ACP CLI probe", () => {
  it.effect("initialize against real kiro-cli acp", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
      expect(typeof started.sessionId).toBe("string");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
