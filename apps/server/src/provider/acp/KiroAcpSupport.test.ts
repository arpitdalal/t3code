import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  applyKiroAcpEffortSelection,
  applyKiroAcpModelSelection,
  buildKiroAcpSpawnInput,
  buildKiroEffortCapabilities,
  enrichKiroModelsWithEffortCapabilities,
  preferredKiroEffortDefault,
  resolveKiroAcpBaseModelId,
  resolveKiroRequestedEffortId,
} from "./KiroAcpSupport.ts";

describe("resolveKiroAcpBaseModelId", () => {
  it("normalizes empty and custom Kiro model ids", () => {
    expect(resolveKiroAcpBaseModelId(undefined)).toBe("auto");
    expect(resolveKiroAcpBaseModelId("   ")).toBe("auto");
    expect(resolveKiroAcpBaseModelId("  kiro-test-custom-model  ")).toBe("kiro-test-custom-model");
  });
});

describe("buildKiroAcpSpawnInput", () => {
  it("spawns kiro-cli acp with optional binary path and env", () => {
    const spawn = buildKiroAcpSpawnInput(
      { binaryPath: "/usr/local/bin/kiro-cli" },
      "/tmp/project",
      { HOME: "/tmp/home" },
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/kiro-cli",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { HOME: "/tmp/home" },
    });
  });

  it("defaults command to kiro-cli when binaryPath is unset", () => {
    expect(buildKiroAcpSpawnInput({ binaryPath: "" }, "/tmp/project")).toEqual({
      command: "kiro-cli",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });
});

describe("buildKiroEffortCapabilities", () => {
  it("returns empty capabilities when a model has no effort levels", () => {
    expect(buildKiroEffortCapabilities([])).toEqual(
      createModelCapabilities({ optionDescriptors: [] }),
    );
  });

  it("defaults to high when available", () => {
    expect(preferredKiroEffortDefault(["low", "medium", "high", "max"])).toBe("high");
    const capabilities = buildKiroEffortCapabilities([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "effort",
        label: "Effort",
        type: "select",
        currentValue: "high",
        options: [
          { id: "none", label: "None" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max" },
        ],
      },
    ]);
  });
});

describe("resolveKiroRequestedEffortId", () => {
  it("reads the effort selection", () => {
    expect(resolveKiroRequestedEffortId([{ id: "effort", value: "max" }])).toBe("max");
    expect(resolveKiroRequestedEffortId([])).toBeUndefined();
  });
});

describe("applyKiroAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: "kiro-mock-alt",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["kiro-mock-alt"]);
      expect(result).toBe("kiro-mock-alt");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: "auto",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("auto");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("auto");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyKiroAcpModelSelection({
          runtime,
          currentModelId: "auto",
          requestedModelId: "kiro-mock-alt",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("applyKiroAcpEffortSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const requests: Array<{ method: string; payload: unknown }> = [];
    const runtime = {
      request: (method: string, payload: unknown) =>
        Effect.gen(function* () {
          requests.push({ method, payload });
          if (failure) return yield* failure;
          return { success: true };
        }),
    };
    return { runtime, requests };
  };

  it.effect("executes /effort when the requested level differs", () =>
    Effect.gen(function* () {
      const { runtime, requests } = makeRecordingRuntime();
      const result = yield* applyKiroAcpEffortSelection({
        runtime,
        sessionId: "sess-1",
        currentEffortId: "medium",
        requestedEffortId: "max",
        mapError: (cause) => cause.message,
      });
      expect(result).toBe("max");
      expect(requests).toEqual([
        {
          method: "_kiro.dev/commands/execute",
          payload: {
            sessionId: "sess-1",
            command: { command: "effort", args: ["max"] },
          },
        },
      ]);
    }),
  );

  it.effect("skips execute when effort is unchanged or unset", () =>
    Effect.gen(function* () {
      const { runtime, requests } = makeRecordingRuntime();
      expect(
        yield* applyKiroAcpEffortSelection({
          runtime,
          sessionId: "sess-1",
          currentEffortId: "high",
          requestedEffortId: "high",
          mapError: (cause) => cause.message,
        }),
      ).toBe("high");
      expect(
        yield* applyKiroAcpEffortSelection({
          runtime,
          sessionId: "sess-1",
          currentEffortId: "high",
          requestedEffortId: undefined,
          mapError: (cause) => cause.message,
        }),
      ).toBe("high");
      expect(requests).toEqual([]);
    }),
  );
});

describe("enrichKiroModelsWithEffortCapabilities", () => {
  it.effect("attaches discovered effort levels and leaves auto empty", () =>
    Effect.gen(function* () {
      const setModels: Array<string> = [];
      let currentModelId = "";
      const levelsByModel: Record<string, ReadonlyArray<{ value: string; label: string }>> = {
        "claude-sonnet-5": [
          { value: "low", label: "low" },
          { value: "high", label: "high  [active]" },
          { value: "max", label: "max" },
        ],
      };
      const runtime = {
        setSessionModel: (modelId: string) =>
          Effect.sync(() => {
            currentModelId = modelId;
            setModels.push(modelId);
            return {};
          }),
        request: (_method: string, _payload: unknown) =>
          Effect.sync(() => ({
            options: [...(levelsByModel[currentModelId] ?? [])],
            hasMore: false,
          })),
      };

      const models = yield* enrichKiroModelsWithEffortCapabilities({
        runtime,
        sessionId: "sess",
        models: [
          {
            slug: "auto",
            name: "Auto",
            isCustom: false,
            capabilities: createModelCapabilities({ optionDescriptors: [] }),
          },
          {
            slug: "claude-sonnet-5",
            name: "claude-sonnet-5",
            isCustom: false,
            capabilities: createModelCapabilities({ optionDescriptors: [] }),
          },
          {
            slug: "deepseek-3.2",
            name: "deepseek-3.2",
            isCustom: false,
            capabilities: createModelCapabilities({ optionDescriptors: [] }),
          },
        ],
      });

      expect(setModels).toEqual(["claude-sonnet-5", "deepseek-3.2"]);
      expect(models[0]?.capabilities.optionDescriptors ?? []).toEqual([]);
      const sonnetEffort = models[1]?.capabilities.optionDescriptors?.[0];
      expect(sonnetEffort).toMatchObject({
        id: "effort",
        label: "Effort",
        type: "select",
        currentValue: "high",
      });
      expect(
        sonnetEffort?.type === "select" ? sonnetEffort.options.map((option) => option.id) : [],
      ).toEqual(["low", "high", "max"]);
      expect(models[2]?.capabilities.optionDescriptors ?? []).toEqual([]);
    }),
  );
});
