import {
  type KiroSettings,
  type ModelCapabilities,
  type ProviderOptionSelection,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  createModelCapabilities,
  getProviderOptionStringSelectionValue,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  buildKiroEffortExecuteParams,
  buildKiroEffortOptionsParams,
  KIRO_COMMANDS_EXECUTE_METHOD,
  KIRO_COMMANDS_OPTIONS_METHOD,
  KIRO_EFFORT_OPTION_ID,
  parseKiroEffortCommandOptions,
} from "./KiroAcpCommands.ts";

const KIRO_DRIVER_KIND = ProviderDriverKind.make("kiro");
const DEFAULT_KIRO_MODEL = "auto";

const KIRO_EFFORT_LABELS: Record<string, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export const EMPTY_KIRO_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

type KiroAcpRuntimeKiroSettings = Pick<KiroSettings, "binaryPath">;

interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiroSettings: KiroAcpRuntimeKiroSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeKiroSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kiroSettings?.binaryPath || "kiro-cli",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKiroAcpSpawnInput(input.kiroSettings, input.cwd, input.environment),
        // Kiro ACP advertises empty authMethods and uses the CLI login session.
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveKiroAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_KIRO_MODEL;
  return normalizeModelSlug(base, KIRO_DRIVER_KIND) ?? DEFAULT_KIRO_MODEL;
}

export function currentKiroModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function kiroEffortLabel(level: string): string {
  return KIRO_EFFORT_LABELS[level] ?? level;
}

export function preferredKiroEffortDefault(levels: ReadonlyArray<string>): string | undefined {
  if (levels.includes("high")) return "high";
  if (levels.includes("medium")) return "medium";
  return levels[0];
}

export function buildKiroEffortCapabilities(levels: ReadonlyArray<string>): ModelCapabilities {
  if (levels.length === 0) {
    return EMPTY_KIRO_MODEL_CAPABILITIES;
  }
  const defaultLevel = preferredKiroEffortDefault(levels);
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: KIRO_EFFORT_OPTION_ID,
        label: "Effort",
        options: levels.map((level) => ({
          value: level,
          label: kiroEffortLabel(level),
          ...(level === defaultLevel ? { isDefault: true } : {}),
        })),
      }),
    ],
  });
}

export function resolveKiroRequestedEffortId(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): string | undefined {
  return getProviderOptionStringSelectionValue(selections, KIRO_EFFORT_OPTION_ID);
}

type KiroEffortDiscoveryRuntime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  "setSessionModel" | "request"
>;

export function discoverKiroEffortLevelsForModel(input: {
  readonly runtime: KiroEffortDiscoveryRuntime;
  readonly sessionId: string;
  readonly modelId: string;
}): Effect.Effect<ReadonlyArray<string>, EffectAcpErrors.AcpError> {
  return Effect.gen(function* () {
    yield* input.runtime.setSessionModel(input.modelId);
    const response = yield* input.runtime.request(
      KIRO_COMMANDS_OPTIONS_METHOD,
      buildKiroEffortOptionsParams({ sessionId: input.sessionId }),
    );
    return parseKiroEffortCommandOptions(response).map((option) => option.value);
  });
}

export function enrichKiroModelsWithEffortCapabilities(input: {
  readonly runtime: KiroEffortDiscoveryRuntime;
  readonly sessionId: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
}): Effect.Effect<ReadonlyArray<ServerProviderModel>> {
  return Effect.gen(function* () {
    const enriched: Array<ServerProviderModel> = [];
    for (const model of input.models) {
      if (model.slug === DEFAULT_KIRO_MODEL) {
        enriched.push({
          ...model,
          capabilities: EMPTY_KIRO_MODEL_CAPABILITIES,
        });
        continue;
      }

      const levels = yield* discoverKiroEffortLevelsForModel({
        runtime: input.runtime,
        sessionId: input.sessionId,
        modelId: model.slug,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kiro effort discovery failed for model", {
            modelId: model.slug,
            errorTag: causeErrorTag(cause),
          }).pipe(Effect.as<ReadonlyArray<string>>([])),
        ),
      );

      enriched.push({
        ...model,
        capabilities: buildKiroEffortCapabilities(levels),
      });
    }
    return enriched;
  });
}

export function applyKiroAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}

export function applyKiroAcpEffortSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">;
  readonly sessionId: string;
  readonly currentEffortId: string | undefined;
  readonly requestedEffortId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchEffort =
    input.requestedEffortId !== undefined && input.requestedEffortId !== input.currentEffortId;
  if (!shouldSwitchEffort) {
    return Effect.succeed(input.currentEffortId);
  }
  return input.runtime
    .request(
      KIRO_COMMANDS_EXECUTE_METHOD,
      buildKiroEffortExecuteParams({
        sessionId: input.sessionId,
        effort: input.requestedEffortId,
      }),
    )
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedEffortId));
}
