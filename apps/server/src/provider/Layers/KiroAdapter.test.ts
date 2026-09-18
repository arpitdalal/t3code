// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  KiroSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeKiroAdapter, kiroUsageIndicatesCompactionComplete } from "./KiroAdapter.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockKiroWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-kiro.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const kiroAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kiro-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeKiroAdapter>[1]) =>
  makeKiroAdapter(decodeKiroSettings({ binaryPath }), options).pipe(Effect.orDie);

describe("kiroUsageIndicatesCompactionComplete", () => {
  it("requires a positive baseline and a lower usedTokens", () => {
    expect(
      kiroUsageIndicatesCompactionComplete({ beforeTokens: 100_000 }, { usedTokens: 20_000 }),
    ).toBe(true);
    expect(
      kiroUsageIndicatesCompactionComplete({ beforeTokens: 100_000 }, { usedTokens: 100_000 }),
    ).toBe(false);
    expect(
      kiroUsageIndicatesCompactionComplete({ beforeTokens: 100_000 }, { usedTokens: 120_000 }),
    ).toBe(false);
    expect(
      kiroUsageIndicatesCompactionComplete({ beforeTokens: null }, { usedTokens: 20_000 }),
    ).toBe(false);
  });
});

it.layer(kiroAdapterTestLayer)("KiroAdapter context window usage", (it) => {
  it.effect("emits thread.token-usage.updated from ACP usage_update session updates", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          T3_ACP_EMIT_USAGE_UPDATE: "1",
          T3_ACP_USAGE_USED: "15000",
          T3_ACP_USAGE_SIZE: "200000",
        }),
      );
      const adapter = yield* makeTestAdapter(binaryPath);
      const threadId = ThreadId.make("thread-usage-1");
      const turnId = TurnId.make("turn-1");

      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const subscriberFiber = yield* Effect.forkScoped(
        Stream.runForEach(
          adapter.streamEvents.pipe(Stream.filter((event) => event.threadId === threadId)),
          (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
        ),
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: null,
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        attachments: [],
        modelSelection: null,
      });

      yield* Fiber.interrupt(subscriberFiber);

      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      expect(usageEvent).toBeDefined();
      expect(usageEvent?.payload).toMatchObject({
        usage: {
          usedTokens: 15_000,
          maxTokens: 200_000,
          compactsAutomatically: true,
        },
      });
    }),
  );

  it.effect("emits thread.token-usage.updated from _kiro.dev/metadata notifications", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          T3_ACP_EMIT_KIRO_METADATA: "1",
          T3_ACP_KIRO_PERCENTAGE: "40",
        }),
      );
      const adapter = yield* makeTestAdapter(binaryPath);
      const threadId = ThreadId.make("thread-metadata-1");
      const turnId = TurnId.make("turn-1");

      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const subscriberFiber = yield* Effect.forkScoped(
        Stream.runForEach(
          adapter.streamEvents.pipe(Stream.filter((event) => event.threadId === threadId)),
          (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
        ),
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: null,
      });

      yield* adapter.sendTurn({
        threadId,
        input: "check metadata",
        attachments: [],
        modelSelection: null,
      });

      yield* Fiber.interrupt(subscriberFiber);

      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      expect(usageEvent).toBeDefined();
      expect(usageEvent?.payload).toMatchObject({
        usage: {
          usedTokens: 80_000,
          maxTokens: 200_000,
          durationMs: 1200,
          compactsAutomatically: true,
        },
      });
    }),
  );

  it.effect("emits thread.token-usage.updated from prompt response usage", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          T3_ACP_EMIT_PROMPT_USAGE: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(binaryPath);
      const threadId = ThreadId.make("thread-prompt-usage-1");
      const turnId = TurnId.make("turn-1");

      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const subscriberFiber = yield* Effect.forkScoped(
        Stream.runForEach(
          adapter.streamEvents.pipe(Stream.filter((event) => event.threadId === threadId)),
          (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
        ),
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: null,
      });

      yield* adapter.sendTurn({
        threadId,
        input: "prompt usage check",
        attachments: [],
        modelSelection: null,
      });

      yield* Fiber.interrupt(subscriberFiber);

      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      expect(usageEvent).toBeDefined();
      expect(usageEvent?.payload).toMatchObject({
        usage: {
          usedTokens: 620,
          totalProcessedTokens: 620,
          inputTokens: 500,
          outputTokens: 120,
          cachedInputTokens: 200,
          compactsAutomatically: true,
        },
      });
    }),
  );

  it.effect("defers turn.completed for /compact until usage drops", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          T3_ACP_EMIT_USAGE_UPDATE: "1",
          T3_ACP_USAGE_USED: "100000",
          T3_ACP_USAGE_SIZE: "200000",
          T3_ACP_POST_COMPACT_USAGE_AFTER_MS: "200",
          T3_ACP_POST_COMPACT_USAGE_USED: "25000",
        }),
      );
      const adapter = yield* makeTestAdapter(binaryPath);
      const threadId = ThreadId.make("thread-async-compact-1");

      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      yield* Effect.forkScoped(
        Stream.runForEach(
          adapter.streamEvents.pipe(Stream.filter((event) => event.threadId === threadId)),
          (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
        ),
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: null,
      });

      const compactTurn = yield* Effect.raceFirst(
        adapter.sendTurn({
          threadId,
          input: "/compact",
          attachments: [],
          modelSelection: null,
        }),
        Effect.promise(
          () =>
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("sendTurn(/compact) hung")), 8_000);
            }),
        ),
      );

      const eventsRightAfterAck = runtimeEvents.filter(
        (event) => event.turnId === compactTurn.turnId,
      );
      expect(
        eventsRightAfterAck.some(
          (event) => event.type === "turn.completed" && event.payload.state === "completed",
        ),
      ).toBe(false);
      expect(
        eventsRightAfterAck.some(
          (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
        ),
      ).toBe(false);

      // Mock post-compact usage uses real setTimeout; wait on wall clock (not TestClock).
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              if (
                runtimeEvents.some(
                  (event) =>
                    event.turnId === compactTurn.turnId &&
                    event.type === "turn.completed" &&
                    event.payload.state === "completed",
                )
              ) {
                resolve();
                return;
              }
              if (Date.now() - startedAt > 3_000) {
                reject(
                  new Error(
                    `Timed out waiting for deferred compact turn.completed. events=${JSON.stringify(
                      runtimeEvents
                        .filter((event) => event.turnId === compactTurn.turnId)
                        .map((event) => event.type),
                    )}`,
                  ),
                );
                return;
              }
              setTimeout(tick, 50);
            };
            tick();
          }),
      );

      const compactEvents = runtimeEvents.filter((event) => event.turnId === compactTurn.turnId);
      const compactedIndex = compactEvents.findIndex(
        (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
      );
      const completedIndex = compactEvents.findIndex(
        (event) => event.type === "turn.completed" && event.payload.state === "completed",
      );
      expect(compactedIndex).toBeGreaterThanOrEqual(0);
      expect(completedIndex).toBeGreaterThan(compactedIndex);
      expect(compactEvents[compactedIndex]?.payload).toMatchObject({
        state: "compacted",
        beforeTokens: 100_000,
        afterTokens: 25_000,
      });

      yield* adapter.stopSession(threadId);
    }),
  );
});
