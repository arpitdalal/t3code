import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import { makeKiroMcp, type KiroMcp } from "../../provider/acp/KiroMcp.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  KiroSettings,
  type ModelSelection,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  KIRO_AGENT_CONFIG_ID,
  KIRO_AUTOPILOT_CONFIG_ID,
  KIRO_EFFORT_CONFIG_ID,
  KIRO_MODEL_CONFIG_ID,
  kiroApprovalOptions,
  kiroAutopilotValue,
  kiroPermissionDisposition,
  makeKiroAcpRuntime,
} from "../../provider/acp/KiroAcpSupport.ts";

export const KIRO_PROVIDER = ProviderDriverKind.make("kiro");
/** T3's slug for "Kiro default", and Kiro's documented default model id. */
const KIRO_DEFAULT_MODEL = "default";
const KIRO_FALLBACK_DEFAULT_MODEL = "auto";
const KiroContextUsage = Schema.Struct({
  kind: Schema.Literal("context_usage"),
  contextUsage: Schema.optional(
    Schema.Struct({
      usagePercentage: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    }),
  ),
  usagePercentage: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ),
});
const decodeKiroContextUsage = Schema.decodeUnknownOption(KiroContextUsage);
const DEFAULT_KIRO_SETTINGS = Schema.decodeSync(KiroSettings)({});

const KiroProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface KiroAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: KiroSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  /**
   * Kiro's id for "Kiro default" (the provider snapshot's `--list-models`
   * default). Absent, it is `auto`.
   */
  readonly defaultModel?: Effect.Effect<string>;
  readonly mcp?: KiroMcp;
  readonly withMcpAccess?: ProviderAuthController["withAccess"];
  readonly onMcpStatus?: () => Effect.Effect<void>;
  /** Replaces the `kiro-cli` launch (replay tests). Kiro's session setup still applies. */
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
}

/** Kiro's `model` option once it advertises one. */
const findKiroModelOption = (configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) =>
  configOptions.find((option) => option.id === KIRO_MODEL_CONFIG_ID || option.category === "model");

// Kiro advertises `model` after session/new, so writes may precede its config option.
// Custom ids still reach Kiro, which rejects unavailable models on the next prompt.
const applyKiroModel = Effect.fn("KiroAdapterV2.applyModel")(function* (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  modelSelection: ModelSelection,
  defaultModel: Effect.Effect<string>,
  agentSwitched: boolean,
) {
  const modelOption = findKiroModelOption(yield* runtime.getConfigOptions);
  const current = modelOption?.type === "select" ? modelOption.currentValue : undefined;
  const selected = modelSelection.model.trim();
  const isDefault = selected.length === 0 || selected === KIRO_DEFAULT_MODEL;
  // Before Kiro advertises `model` the session is new, so it already runs
  // Kiro's default, unless an agent switch just moved it to the agent's model.
  if (isDefault && modelOption?.type !== "select" && !agentSwitched) {
    return current;
  }
  const requested = isDefault ? yield* defaultModel : selected;
  if (requested === current) {
    return current;
  }
  yield* runtime.setConfigOption(modelOption?.id ?? KIRO_MODEL_CONFIG_ID, requested, {
    allowUnlistedValue: true,
  });
  return requested;
});

/**
 * Bound on waiting for Kiro to advertise the model T3 just wrote. Kiro 2.27.0
 * sent it 40-90 ms after the write's result.
 */
const KIRO_MODEL_ADVERT_BOUND = "2 seconds";

// Kiro ignores effort writes until it advertises the selected model's effort option.
// Missing adverts and rejected writes preserve Kiro's default rather than failing the turn.
const applyKiroEffort = Effect.fn("KiroAdapterV2.applyEffort")(function* (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  modelSelection: ModelSelection,
  appliedModel: string | undefined,
) {
  const requested = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
  if (requested === undefined) return;
  const advertised = yield* runtime.configOptionChanges.pipe(
    Stream.filter((configOptions) => {
      const modelOption = findKiroModelOption(configOptions);
      return (
        appliedModel === undefined ||
        (modelOption?.type === "select" && modelOption.currentValue === appliedModel)
      );
    }),
    Stream.runHead,
    Effect.timeoutOption(KIRO_MODEL_ADVERT_BOUND),
    Effect.map(Option.flatten),
  );
  if (Option.isNone(advertised)) {
    return yield* Effect.logWarning("Kiro did not advertise the model's reasoning effort", {
      model: appliedModel,
      value: requested,
    });
  }
  const effortOption = advertised.value.find((option) => option.id === KIRO_EFFORT_CONFIG_ID);
  if (effortOption?.type !== "select" || !selectValues(effortOption).includes(requested)) {
    return;
  }
  yield* runtime.setConfigOption(KIRO_EFFORT_CONFIG_ID, requested).pipe(
    Effect.catchTags({
      AcpRequestError: (error) =>
        Effect.logWarning("Kiro rejected the reasoning effort", {
          value: requested,
          detail: error.message,
        }),
    }),
  );
});

// Switching agents resets the model, so apply the agent before the thread's model choice.
// Skip unlisted agents because Kiro accepts their writes without switching.
const applyKiroAgent = Effect.fn("KiroAdapterV2.applyAgent")(function* (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  modelSelection: ModelSelection,
) {
  const requested = getModelSelectionStringOptionValue(modelSelection, KIRO_AGENT_CONFIG_ID);
  if (requested === undefined) return false;
  const agentOption = (yield* runtime.getConfigOptions).find(
    (option) => option.id === KIRO_AGENT_CONFIG_ID,
  );
  if (agentOption?.type !== "select" || agentOption.currentValue === requested) return false;
  if (!selectValues(agentOption).includes(requested)) {
    yield* Effect.logWarning("Kiro does not list the thread's agent", { agent: requested });
    return false;
  }
  yield* runtime.setConfigOption(KIRO_AGENT_CONFIG_ID, requested);
  return true;
});

const applyKiroModelSelection =
  (defaultModel: Effect.Effect<string>): NonNullable<AcpAdapterV2Flavor["applyModelSelection"]> =>
  ({ runtime, modelSelection }) =>
    applyKiroAgent(runtime, modelSelection).pipe(
      Effect.flatMap((agentSwitched) =>
        applyKiroModel(runtime, modelSelection, defaultModel, agentSwitched),
      ),
      Effect.tap((appliedModel) => applyKiroEffort(runtime, modelSelection, appliedModel)),
    );

function selectValues(
  option: Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }>,
): ReadonlyArray<string> {
  return option.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
  );
}

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

// Kiro 2.27.1 can drop early cancels; wait for prompt activity or the bounded fallback.
// Message-id echoes precede cancel readiness, and context usage may belong to the previous prompt.
function isKiroPromptActivity(update: EffectAcpSchema.SessionUpdate): boolean {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_message":
    case "agent_thought_chunk":
    case "agent_thought":
    case "tool_call":
    case "tool_call_update":
    case "tool_call_content_chunk":
    case "plan_update":
      return true;
    case "session_info_update": {
      const kiro = update._meta?.kiro;
      return (
        typeof kiro === "object" && kiro !== null && "kind" in kiro && kiro.kind === "turn_start"
      );
    }
    default:
      return false;
  }
}

/** Past TinBane's dropped 0-0.5 s window and his honored 1.5 s cancel. */
const KIRO_CANCEL_HOLD_BOUND = "2 seconds";

/**
 * Kiro's prompt errors carry a message meant for the user (live 2.27: -32000
 * "The model 'x' is not available. Please select a different model and try
 * again. (Request ID: …)"). Show it instead of the generic failure text;
 * makeProviderFailure bounds and redacts it.
 */
function kiroPromptFailure(cause: unknown) {
  return makeProviderFailure({
    cause,
    ...(isAcpRequestError(cause) ? { message: cause.message, code: String(cause.code) } : {}),
    class: "provider_error",
  });
}

function makeKiroAcpAdapterFlavor(
  options: KiroAdapterV2Options & { readonly mcp: KiroMcp },
): AcpAdapterV2Flavor {
  const makeRuntime =
    options.makeRuntime ??
    ((input: AcpAdapterV2RuntimeInput) => {
      const { runtimePolicy: _runtimePolicy, processEnvironment, ...runtimeInput } = input;
      return makeKiroAcpRuntime({
        ...runtimeInput,
        settings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
      });
    });
  return {
    driver: KIRO_PROVIDER,
    runtimeHarness: "Kiro",
    sessionMetadata: ({ update }) => {
      if (update.sessionUpdate !== "session_info_update") return undefined;
      const usage = Option.getOrUndefined(decodeKiroContextUsage(update._meta?.kiro));
      const percentage = usage?.contextUsage?.usagePercentage ?? usage?.usagePercentage;
      return percentage === undefined ? undefined : { contextUsagePercentage: percentage };
    },
    capabilities: KiroProviderCapabilitiesV2,
    supportsCompaction: true,
    compact: Effect.fn("KiroAdapterV2.compact")(
      function* (runtime) {
        const started = yield* runtime.start();
        const meta = started.initializeResult.agentCapabilities?._meta?.kiro;
        const methods =
          typeof meta === "object" && meta !== null && "extensionMethods" in meta
            ? meta.extensionMethods
            : undefined;
        if (!Array.isArray(methods) || !methods.includes("_kiro/session/compact")) {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32601,
            errorMessage: "This Kiro server does not support compaction.",
          });
        }
        yield* runtime.request("_kiro/session/compact", { sessionId: started.sessionId });
        yield* runtime.drainEvents;
        return { stopReason: "end_turn" as const };
      },
      Effect.timeoutOrElse({
        duration: "3 minutes",
        orElse: () =>
          Effect.fail(
            new EffectAcpErrors.AcpRequestError({
              code: -32603,
              errorMessage: "Kiro context compaction timed out.",
            }),
          ),
      }),
    ),
    makeRuntime: (input) => {
      const creation = Effect.gen(function* () {
        const runtime = yield* makeRuntime({
          ...input,
          clientCapabilities: {
            ...input.clientCapabilities,
            _meta: { ...input.clientCapabilities?._meta, kiro: { secretStorage: true } },
          },
        });
        const attached = yield* options.mcp.attach(runtime, {
          cwd: input.cwd,
          ...(options.onMcpStatus ? { onStatus: options.onMcpStatus } : {}),
        });
        yield* Effect.addFinalizer(() => attached.detach);
        return attached.runtime;
      });
      return (options.withMcpAccess ? options.withMcpAccess(creation) : creation).pipe(
        Effect.catchTags({
          ProviderSetupError: (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Finish or cancel Kiro MCP sign-in before starting a thread.",
              cause,
            }),
        }),
      );
    },
    promptFailure: kiroPromptFailure,
    // See applyKiroModelSelection: `model` arrives after session/new.
    modelOptionArrivesLate: true,
    applyModelSelection: applyKiroModelSelection(
      options.defaultModel ?? Effect.succeed(KIRO_FALLBACK_DEFAULT_MODEL),
    ),
    // The generic option loop runs after the model write, and an agent write
    // there would put the agent's own model back.
    ownedModelOptionIds: ["reasoningEffort", KIRO_AGENT_CONFIG_ID],
    // Autopilot controls Kiro's final change review; tool prompts still pass through T3's policy.
    sessionConfigForPolicy: (policy) => [
      { id: KIRO_AUTOPILOT_CONFIG_ID, value: kiroAutopilotValue(policy) },
    ],
    // See isKiroPromptActivity: Kiro 2.27.1 can drop a cancel sent just after
    // `session/prompt` and run the turn to completion.
    cancelAfterPromptStarts: { isStart: isKiroPromptActivity, bound: KIRO_CANCEL_HOLD_BOUND },
    permissionDisposition: kiroPermissionDisposition,
    approvalOptions: kiroApprovalOptions,
    // Kiro V3 advertises `promptCapabilities.image`; the shared adapter reads it.
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeKiroAdapterV2 = Effect.fn("makeKiroAdapterV2")(function* (
  options: KiroAdapterV2Options,
) {
  const mcp =
    options.mcp ??
    (yield* makeKiroMcp({
      instanceId: options.instanceId,
      environment: options.environment,
    }));
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeKiroAcpAdapterFlavor({ ...options, mcp }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type KiroAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

/**
 * `defaultModel` reads Kiro's id for "Kiro default" from the provider
 * snapshot; without one (the bare V2 adapter registry) it is `auto`.
 */
export const makeKiroAdapterV2Driver = (
  options: Pick<
    KiroAdapterV2Options,
    "defaultModel" | "mcp" | "onMcpStatus" | "withMcpAccess"
  > = {},
): ProviderAdapterDriver<KiroSettings, KiroAdapterV2DriverEnv> => ({
  driverKind: KIRO_PROVIDER,
  configSchema: KiroSettings,
  defaultConfig: (): KiroSettings => DEFAULT_KIRO_SETTINGS,
  create: Effect.fn("KiroAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<KiroSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeKiroAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        ...options,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: KIRO_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: KIRO_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Kiro ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
});
