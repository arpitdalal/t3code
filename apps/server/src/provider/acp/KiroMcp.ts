import {
  ProviderSetupError,
  type ProviderAuthState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as AcpErrors from "effect-acp/errors";
import { resolveKiroHomeDirPath } from "../Drivers/KiroSkills.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const SecretKey = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});
const SecretValue = Schema.Struct({
  ...SecretKey.fields,
  value: Schema.String.check(Schema.isMaxLength(1_048_576)),
});
const Secrets = Schema.Record(Schema.String, Schema.String);
const decodeSecrets = Schema.decodeEffect(Schema.fromJsonString(Secrets));
const isSetupError = Schema.is(ProviderSetupError);
type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
type McpRuntime = Pick<
  Runtime,
  "handleExtRequest" | "handleExtNotification" | "prompt" | "start" | "getModeState" | "setMode"
>;

const decodeMcpSource = Schema.decodeUnknownOption(
  Schema.Struct({
    kiro: Schema.Struct({ resource: Schema.Struct({ krn: Schema.String }) }),
  }),
);
const ServerStatus = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  status: Schema.String,
  authType: Schema.optionalKey(Schema.String),
  failedAuthorization: Schema.optionalKey(Schema.Boolean),
  _meta: Schema.optionalKey(Schema.Unknown),
});
const McpStatus = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  servers: Schema.Array(ServerStatus),
});
const decodeMcpStatus = Schema.decodeUnknownOption(McpStatus);

/** Replay fixtures retain connection state, never authorization URLs or native metadata. */
export function kiroMcpStatusForRecording(value: unknown) {
  const parsed = decodeMcpStatus(value);
  if (Option.isNone(parsed)) return undefined;
  return {
    ...(parsed.value.sessionId ? { sessionId: parsed.value.sessionId } : {}),
    servers: parsed.value.servers.map(({ name, status, authType, failedAuthorization }) => ({
      name,
      status,
      ...(authType === undefined ? {} : { authType }),
      ...(failedAuthorization === undefined ? {} : { failedAuthorization }),
    })),
  };
}

type McpServerStatus = typeof ServerStatus.Type;

const protocolError = (cause: unknown) =>
  new AcpErrors.AcpTransportError({
    detail: "Could not access Kiro MCP credentials.",
    cause,
  });

/** Kiro owns OAuth; T3 persists its opaque secrets without interpreting token contents. */
export const makeKiroMcp = Effect.fn("makeKiroMcp")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const host = yield* ProviderHost.ProviderHost;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const kiroHome = yield* resolveKiroHomeDirPath(input.environment, host.paths.cwd);
  const credentials = yield* host.credentials("kiro-mcp", input.instanceId);
  const lock = yield* Semaphore.make(1);
  const knownServers = new Map<string, McpServerStatus>();
  const servers = new Map<string, { name: string; disabled?: boolean }>();
  const observations = new Set<Map<string, Map<string, McpServerStatus>>>();
  const liveServers = () => {
    const current = new Map<string, McpServerStatus>();
    for (const sessions of observations) {
      for (const report of sessions.values()) {
        for (const [id, server] of report) {
          // A failed connection in another thread must not hide a working one.
          if (current.get(id)?.status !== "connected") current.set(id, server);
        }
      }
    }
    return current;
  };
  const serverName = (name: string, cwd: string, modeId?: string) =>
    `${name} MCP${cwd === host.paths.cwd ? "" : ` · ${cwd}`}${modeId && modeId !== "vibe" ? ` · ${modeId}` : ""}`;
  const targets = new Map<string, { name: string; cwd: string; modeId?: string }>();
  const targetId = (name: string, cwd: string, modeId?: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(JSON.stringify([name, cwd, modeId ?? "vibe"])))
      .pipe(
        Effect.map((bytes) => `mcp:${Hex.encode(bytes)}`),
        Effect.orDie,
      );
  const configuredNames = new Set<string>();
  const configuredIds = new Set<string>();
  const readSecrets = credentials.get.pipe(
    Effect.flatMap((bytes) =>
      Option.isNone(bytes)
        ? Effect.succeed({} as Record<string, string>)
        : decodeSecrets(new TextDecoder().decode(bytes.value)),
    ),
    Effect.mapError(protocolError),
  );
  const writeSecrets = (secrets: Readonly<Record<string, string>>) =>
    credentials
      .set(new TextEncoder().encode(JSON.stringify(secrets)))
      .pipe(Effect.mapError(protocolError));

  const methods = Effect.gen(function* () {
    const configPath = path.join(kiroHome, "settings", "mcp.json");
    const previousConfiguredIds = new Set(configuredIds);
    configuredIds.clear();
    configuredNames.clear();
    if (yield* fs.exists(configPath)) {
      const config = yield* fs.readFileString(configPath).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                mcpServers: Schema.Record(
                  Schema.String,
                  Schema.Struct({
                    url: Schema.optionalKey(Schema.String),
                    disabled: Schema.optionalKey(Schema.Boolean),
                  }),
                ),
              }),
            ),
          ),
        ),
      );
      for (const [name, server] of Object.entries(config.mcpServers)) {
        const id = yield* targetId(name, host.paths.cwd);
        configuredIds.add(id);
        servers.set(id, {
          name: serverName(name, host.paths.cwd),
          disabled: server.disabled === true,
        });
        if (server.url && !server.disabled) configuredNames.add(name);
        else targets.delete(id);
      }
    }
    for (const id of previousConfiguredIds) {
      if (!configuredIds.has(id)) {
        targets.delete(id);
        servers.delete(id);
        knownServers.delete(id);
      }
    }
    for (const name of configuredNames)
      targets.set(yield* targetId(name, host.paths.cwd), { name, cwd: host.paths.cwd });
    return [...targets.entries()].map(([id, { name, cwd, modeId }]) => ({
      id,
      name: serverName(name, cwd, modeId),
      type: "agent" as const,
      description: knownServers.get(id)?.failedAuthorization
        ? "Authentication required. Sign in to connect this MCP server."
        : "Sign in or reconnect this MCP server.",
    }));
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "methods",
          detail: "Could not read Kiro MCP configuration.",
          cause,
        }),
    ),
  );

  const mcpServers = Effect.sync(() => {
    const live = liveServers();
    return [...servers].map(([id, server]) => {
      const report = live.get(id) ?? knownServers.get(id);
      const status: NonNullable<ProviderAuthState["mcpServers"]>[number]["status"] = server.disabled
        ? "Disabled"
        : report?.status === "connected"
          ? "Connected"
          : report?.failedAuthorization
            ? "Authentication required"
            : report?.status === "connecting"
              ? "Connecting"
              : report?.status === "failed"
                ? "Connection failed"
                : report
                  ? "Not connected"
                  : "Not checked";
      return { id, name: server.name, status, live: !server.disabled && live.has(id) };
    });
  });

  const attach = Effect.fn("KiroMcp.attach")(function* <R extends McpRuntime>(
    runtime: R,
    options: {
      readonly cwd: string;
      readonly onStatus?: () => Effect.Effect<void>;
      readonly onOpenUrl?: (url: string) => Effect.Effect<boolean, AcpErrors.AcpError>;
    },
  ) {
    const reports = new Map<string, Map<string, McpServerStatus>>();
    observations.add(reports);
    const detach = Effect.gen(function* () {
      observations.delete(reports);
      yield* options.onStatus?.() ?? Effect.void;
    });
    const status = yield* SubscriptionRef.make<ReadonlyArray<McpServerStatus>>([]);
    const snapshots = yield* SubscriptionRef.make<
      ReadonlyMap<string, ReadonlyArray<McpServerStatus>>
    >(new Map());
    yield* runtime.handleExtRequest("_kiro/secret/get", SecretKey, ({ key }) =>
      lock
        .withPermit(readSecrets)
        .pipe(
          Effect.map((secrets) => ({ value: Object.hasOwn(secrets, key) ? secrets[key] : null })),
        ),
    );
    yield* runtime.handleExtRequest("_kiro/secret/store", SecretValue, ({ key, value }) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* writeSecrets({ ...(yield* readSecrets), [key]: value });
          return {};
        }),
      ),
    );
    yield* runtime.handleExtRequest("_kiro/secret/delete", SecretKey, ({ key }) =>
      lock.withPermit(
        Effect.gen(function* () {
          const secrets = { ...(yield* readSecrets) };
          delete secrets[key];
          yield* writeSecrets(secrets);
          return {};
        }),
      ),
    );
    yield* runtime.handleExtNotification("_kiro/mcp/status", McpStatus, (snapshot) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.set(status, snapshot.servers);
        yield* SubscriptionRef.update(snapshots, (current) =>
          new Map(current).set(snapshot.sessionId ?? "", snapshot.servers),
        );
        const modeId = (yield* runtime.getModeState)?.currentModeId;
        const report = new Map<string, McpServerStatus>();
        for (const server of snapshot.servers) {
          const source = decodeMcpSource(server._meta);
          const global =
            Option.isSome(source) &&
            source.value.kiro.resource.krn.startsWith(
              "krn:user-local::mcp-server/settings/mcp.json#",
            );
          const cwd = global ? host.paths.cwd : options.cwd;
          const agent = global ? undefined : modeId;
          const id = yield* targetId(server.name, cwd, agent);
          servers.set(id, { ...servers.get(id), name: serverName(server.name, cwd, agent) });
          report.set(id, server);
          knownServers.set(id, server);
          if (
            server.authType === "oauth" ||
            server.failedAuthorization ||
            configuredNames.has(server.name)
          ) {
            targets.set(id, { name: server.name, cwd, ...(agent ? { modeId: agent } : {}) });
          }
        }
        reports.set(snapshot.sessionId ?? "", report);
        yield* options.onStatus?.() ?? Effect.void;
      }),
    );
    if (options.onOpenUrl) {
      yield* runtime.handleExtRequest(
        "_kiro/openExternalUrl",
        Schema.Struct({ url: Schema.String.check(Schema.isMaxLength(16_384)) }),
        ({ url }) => options.onOpenUrl!(url).pipe(Effect.map((success) => ({ success }))),
      );
    }
    return {
      status,
      detach,
      runtime: {
        ...runtime,
        prompt: Effect.fn("KiroMcp.prompt")(function* (request, promptOptions) {
          const started = yield* runtime.start();
          const sessionServers = (current: ReadonlyMap<string, ReadonlyArray<McpServerStatus>>) =>
            current.get(started.sessionId) ?? current.get("");
          if (sessionServers(yield* SubscriptionRef.get(snapshots)) !== undefined) {
            yield* SubscriptionRef.changes(snapshots).pipe(
              Stream.filter((current) => {
                const servers = sessionServers(current);
                return (
                  servers !== undefined &&
                  !servers.some(
                    (server) => server.authType === "oauth" && server.status === "connecting",
                  )
                );
              }),
              Stream.runHead,
              Effect.timeoutOption("65 seconds"),
            );
          }
          const unavailable = (sessionServers(yield* SubscriptionRef.get(snapshots)) ?? []).filter(
            (server) => server.status === "failed",
          );
          const notice =
            unavailable.length === 0
              ? []
              : [
                  {
                    type: "text" as const,
                    text: `Kiro MCP connection status: ${unavailable.map((server) => `${JSON.stringify(server.name)}: ${server.failedAuthorization ? "authentication required" : "connection failed"}`).join("; ")}. These servers are configured but their tools are unavailable. For authentication, ask the user to open Settings > Providers > Kiro and sign in with the server's MCP method.`,
                  },
                ];
          return yield* runtime.prompt(
            { ...request, prompt: [...notice, ...request.prompt] },
            promptOptions,
          );
        }),
      } satisfies McpRuntime,
    };
  });
  return {
    attach,
    methods,
    mcpServers,
    credentials,
    clear: credentials.remove.pipe(Effect.tap(() => Effect.sync(() => knownServers.clear()))),
    targets,
    instanceId: input.instanceId,
  };
});
export type KiroMcp = Effect.Success<ReturnType<typeof makeKiroMcp>>;

const webUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.hash
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
};

/** Only relay the exact loopback callback advertised by this live OAuth attempt. */
export function kiroMcpCallbackUrl(authorizationUrl: string, value: string): string | undefined {
  try {
    const auth = webUrl(authorizationUrl);
    const redirect = new URL(auth?.searchParams.get("redirect_uri") ?? "");
    const callback = new URL(value);
    if (
      value.length > 16_384 ||
      redirect.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname) ||
      Number(redirect.port) < 1024 ||
      redirect.username ||
      redirect.password ||
      redirect.hash ||
      callback.origin !== redirect.origin ||
      callback.pathname !== redirect.pathname ||
      callback.username ||
      callback.password ||
      callback.hash ||
      callback.searchParams.getAll("code").length !== 1 ||
      !callback.searchParams.get("code") ||
      callback.searchParams.getAll("state").length !== 1 ||
      !auth?.searchParams.get("state") ||
      callback.searchParams.get("state") !== auth.searchParams.get("state")
    )
      return undefined;
    return callback.href;
  } catch {
    return undefined;
  }
}

export const makeKiroMcpAuth = Effect.fn("makeKiroMcpAuth")(function* (input: {
  readonly mcp: KiroMcp;
  readonly makeRuntime: (
    cwd: string,
  ) => Effect.Effect<
    McpRuntime & Pick<Runtime, "request">,
    AcpErrors.AcpError,
    import("effect/Scope").Scope
  >;
}) {
  const { mcp } = input;
  const httpClient = yield* HttpClient.HttpClient;
  const setupError = (detail: string, cause?: unknown) =>
    new ProviderSetupError({
      instanceId: mcp.instanceId,
      operation: "authenticate",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const auth = yield* ProviderAuthFlow.make({
    instanceId: mcp.instanceId,
    purpose: "mcp",
    credentialBinding: mcp.credentials.binding,
    methods: mcp.methods,
    mcpServers: mcp.mcpServers,
    refreshMethodsAfterAuth: true,
    logout: mcp.clear.pipe(
      Effect.mapError((cause) => setupError("Could not clear Kiro MCP credentials.", cause)),
    ),
    authenticate: Effect.fn("KiroMcp.authenticate")(
      function* (methodId, context) {
        const target = mcp.targets.get(methodId);
        if (!target) return yield* setupError("This MCP server is no longer configured.");
        const serverName = target.name;
        const runtime = yield* input.makeRuntime(target.cwd);
        const { status, detach } = yield* mcp.attach(runtime, {
          cwd: target.cwd,
          onStatus: (): Effect.Effect<void> => auth.refreshMethods ?? Effect.void,
          onOpenUrl: Effect.fn("KiroMcp.openUrl")(
            function* (value) {
              const url = webUrl(value);
              if (!url) return false;
              const consent = yield* Deferred.make<boolean>();
              yield* context.setInteraction(
                {
                  type: "browser",
                  id: context.flowId,
                  url: url.href,
                  requiresConsent: true,
                  acceptsCallback: true,
                },
                (response) =>
                  Deferred.succeed(
                    consent,
                    response.type === "browser" && response.action === "accept",
                  ).pipe(Effect.asVoid),
                (callback) => {
                  const target = kiroMcpCallbackUrl(url.href, callback);
                  if (!target)
                    return Effect.fail(
                      setupError("The redirect URL does not match this MCP sign-in."),
                    );
                  return httpClient.execute(HttpClientRequest.get(target)).pipe(
                    // Callback query parameters contain the authorization code.
                    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
                    Effect.timeout("10 seconds"),
                    Effect.mapError((cause) =>
                      setupError("Could not deliver the MCP callback to Kiro.", cause),
                    ),
                    Effect.flatMap((response) =>
                      response.status >= 200 && response.status < 400
                        ? Effect.void
                        : Effect.fail(setupError("Kiro rejected the MCP callback.")),
                    ),
                  );
                },
              );
              return yield* Deferred.await(consent);
            },
            Effect.mapError(
              (cause) =>
                new AcpErrors.AcpTransportError({ detail: "Kiro MCP sign-in failed.", cause }),
            ),
          ),
        });
        yield* Effect.addFinalizer(() => detach);
        const started = yield* runtime.start();
        if (target.modeId) yield* runtime.setMode(target.modeId);
        const settled = () =>
          SubscriptionRef.changes(status).pipe(
            Stream.filter((servers) =>
              servers.some(
                (server) => server.name === serverName && server.status !== "connecting",
              ),
            ),
            Stream.runHead,
          );
        yield* settled();
        yield* SubscriptionRef.set(status, []);
        // Kiro 2.31.1 implements resetServer without listing it in extensionMethods.
        yield* runtime
          .request("_kiro/mcp/resetServer", {
            sessionId: started.sessionId,
            serverName,
            startOAuth: true,
          })
          .pipe(
            Effect.catchTags({
              AcpRequestError: (cause) =>
                cause.code === -32601
                  ? setupError("This Kiro version does not support MCP sign-in over ACP.", cause)
                  : Effect.fail(cause),
            }),
          );
        const result = yield* settled();
        if (
          Option.isNone(result) ||
          !result.value.some(
            (server) => server.name === serverName && server.status === "connected",
          )
        ) {
          return yield* setupError("Kiro could not connect the MCP server. Try signing in again.");
        }
        yield* context.verifying;
      },
      Effect.mapError((cause) =>
        isSetupError(cause) ? cause : setupError("Kiro MCP sign-in failed. Try again.", cause),
      ),
    ),
  });
  return auth;
});
