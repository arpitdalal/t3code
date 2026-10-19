import { type KiroSettings, TextGenerationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { makeKiroAcpRuntime } from "../provider/acp/KiroAcpSupport.ts";

/** Kiro supplies the runner; upstream owns prompts, naming policy and sanitization. */
export const makeKiroTextGeneration = Effect.fn("makeKiroTextGeneration")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run: TextGenerationOperations.Runner = Effect.fn("KiroTextGeneration.run")(
    function* <S extends Schema.Top>(input: TextGenerationOperations.Request<S>) {
      const runtime = yield* makeKiroAcpRuntime({
        settings,
        environment,
        cwd: input.cwd,
        clientInfo: { name: "t3-code-kiro-text", version: "0.0.0" },
      });
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) =>
          event._tag === "EventStreamBarrier"
            ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      const output = yield* Ref.make("");
      yield* runtime.handleSessionUpdate(({ update }) => {
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text")
          return Effect.void;
        const text = update.content.text;
        return Ref.update(output, (current) => current + text);
      });
      yield* runtime.handleRequestPermission(() =>
        Effect.succeed({
          outcome: { outcome: "cancelled" as const },
        }),
      );
      yield* runtime.start();
      yield* runtime.setConfigOption("autopilot", "off");
      const model = input.modelSelection.model.trim();
      if (model && model !== "default") {
        yield* runtime.setConfigOption("model", model, { allowUnlistedValue: true });
      }
      const result = yield* runtime.prompt({ prompt: [{ type: "text", text: input.prompt }] });
      const text = (yield* Ref.get(output)).trim();
      if (!text || result.stopReason === "cancelled") {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            result.stopReason === "cancelled"
              ? "Kiro ACP request was cancelled."
              : "Kiro returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(input, "Kiro", text);
    },
    (effect, input) =>
      effect.pipe(
        Effect.timeout("3 minutes"),
        Effect.mapError((cause) =>
          cause._tag === "TextGenerationError"
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "Kiro ACP text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
  );
  return TextGenerationOperations.fromRunner(
    "KiroTextGeneration",
    TextGenerationOperations.withoutInvestigation("Kiro", run),
  );
});
