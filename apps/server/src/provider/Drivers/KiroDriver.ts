import { KiroSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { HttpClient } from "effect/http";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { makeKiroTextGeneration } from "../../textGeneration/KiroTextGeneration.ts";
import {
  type KiroAdapterV2DriverEnv,
  makeKiroAdapterV2Driver,
} from "../../orchestration-v2/Adapters/KiroAdapterV2.ts";
import {
  buildInitialKiroProviderSnapshot,
  checkKiroProviderStatus,
  kiroDefaultModelId,
} from "../KiroProvider.ts";

import { makeKiroMcp, makeKiroMcpAuth } from "../acp/KiroMcp.ts";
import { makeKiroAcpRuntime } from "../acp/KiroAcpSupport.ts";

import { discoverKiroSkills } from "./KiroSkills.ts";

const DRIVER_KIND = ProviderDriverKind.make("kiro");
const decodeKiroSettings = Schema.decodeSync(KiroSettings);
// Kiro updates itself in the background (`kiro-cli update` reports only), so
// T3 offers no one-click update.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type KiroDriverEnv =
  | HttpClient.HttpClient
  | KiroAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | ProviderHost.ProviderHost
  | FileSystem.FileSystem
  | Path.Path;

export const KiroDriver: ProviderDriver<KiroSettings, KiroDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Kiro",
    supportsMultipleInstances: true,
  },
  configSchema: KiroSettings,
  defaultConfig: (): KiroSettings => decodeKiroSettings({}),
  create: Effect.fn("KiroDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampInstanceIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const stampIdentity = (current: Parameters<typeof stampInstanceIdentity>[0]) => ({
      ...stampInstanceIdentity(current),
      setup: { canAuthenticate: true, canInstall: false },
    });
    const effectiveConfig = { ...config, enabled } satisfies KiroSettings;
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<KiroSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialKiroProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkKiroProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            // The cause keeps the failure; the detail reaches the snapshot, so it stays fixed.
            detail: "Failed to build Kiro snapshot.",
            cause,
          }),
      ),
    );

    const mcp = yield* makeKiroMcp({
      instanceId,
      environment: processEnv,
    });
    const mcpAuth = yield* makeKiroMcpAuth({
      mcp,
      makeRuntime: (cwd) =>
        makeKiroAcpRuntime({
          settings: effectiveConfig,
          environment: processEnv,
          cwd,
          clientInfo: { name: "t3-code", version: "0.0.0" },
          clientCapabilities: { _meta: { kiro: { secretStorage: true, openExternalUrl: true } } },
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Crypto.Crypto, crypto),
        ),
    });
    // "Kiro default" selects the default the snapshot read from Kiro's model list.
    const orchestrationAdapter = yield* makeKiroAdapterV2Driver({
      defaultModel: snapshot.getSnapshot.pipe(
        Effect.map((current) => kiroDefaultModelId(current.models)),
      ),
      mcp,
      onMcpStatus: () => mcpAuth.refreshMethods ?? Effect.void,
      ...(mcpAuth.withAccess ? { withMcpAccess: mcpAuth.withAccess } : {}),
    })
      .create({ instanceId, displayName, accentColor, environment, enabled, config })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Kiro orchestration adapter.",
              cause,
            }),
        ),
      );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd: (cwd) =>
        !enabled
          ? snapshot.getSnapshot
          : Effect.all([snapshot.getSnapshot, discoverKiroSkills(cwd, processEnv)]).pipe(
              Effect.map(([current, skills]) => ({ ...current, skills })),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            ),
      orchestrationAdapter,
      auth: mcpAuth,
      textGeneration: yield* makeKiroTextGeneration(effectiveConfig, processEnv),
    } satisfies ProviderInstance;
  }),
};
