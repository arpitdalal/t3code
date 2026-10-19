import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderCredentialError } from "@t3tools/provider-core/server/errors";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as AcpErrors from "effect-acp/errors";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  kiroMcpCallbackUrl,
  kiroMcpStatusForRecording,
  makeKiroMcp,
  makeKiroMcpAuth,
} from "./KiroMcp.ts";

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
const instanceId = ProviderInstanceId.make("kiro-test");
const layer = TestProviderHost.layer().pipe(Layer.provideMerge(NodeServices.layer));
const makeMcp = (id = instanceId) =>
  makeKiroMcp({ instanceId: id, environment: { KIRO_HOME: "/missing-test-home/.kiro" } });
const initializeResult = {
  protocolVersion: 1,
  agentCapabilities: { _meta: { kiro: { extensionMethods: ["_kiro/config/template"] } } },
};
const makePeer = () => {
  const requests = new Map<
    string,
    (params: unknown) => Effect.Effect<unknown, AcpErrors.AcpError>
  >();
  const notifications = new Map<
    string,
    (params: unknown) => Effect.Effect<void, AcpErrors.AcpError>
  >();
  const prompts: Array<Parameters<Runtime["prompt"]>[0]> = [];
  const runtime = {
    handleExtRequest: (method, schema, handler) =>
      Effect.sync(() => {
        requests.set(method, (params) =>
          Schema.decodeUnknownEffect(schema)(params).pipe(
            Effect.mapError(
              (cause) => new AcpErrors.AcpTransportError({ detail: "Invalid test request", cause }),
            ),
            Effect.flatMap((decoded) => handler(decoded, { method, requestId: "test-request" })),
          ),
        );
      }),
    handleExtNotification: (method, schema, handler) =>
      Effect.sync(() => {
        notifications.set(method, (params) =>
          Schema.decodeUnknownEffect(schema)(params).pipe(
            Effect.mapError(
              (cause) =>
                new AcpErrors.AcpTransportError({ detail: "Invalid test notification", cause }),
            ),
            Effect.flatMap(handler),
          ),
        );
      }),
    start: () =>
      Effect.succeed({
        sessionId: "session",
        initializeResult,
        sessionSetupResult: { sessionId: "session" },
        modelConfigId: undefined,
      }),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
    getModeState: Effect.succeed(undefined),
    setMode: () => Effect.succeed({}),
    prompt: (request) =>
      Effect.sync(() => {
        prompts.push(request);
        return { stopReason: "end_turn" as const };
      }),
  } satisfies Pick<
    Runtime,
    "handleExtRequest" | "handleExtNotification" | "start" | "prompt" | "getModeState" | "setMode"
  >;
  return {
    runtime,
    prompts,
    request: (method: string, params: unknown) =>
      Effect.suspend(() => requests.get(method)!(params)),
    status: (servers: ReadonlyArray<Record<string, unknown>>, sessionId = "session") =>
      Effect.suspend(() => notifications.get("_kiro/mcp/status")!({ sessionId, servers })),
  };
};

it.layer(layer)("Kiro MCP credentials and status", (it) => {
  it.effect("discovers enabled HTTP servers from the instance's KIRO_HOME", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-mcp-config-" });
      yield* fs.makeDirectory(path.join(home, "settings"));
      yield* fs.writeFileString(
        path.join(home, "settings", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            workato: { type: "http", url: "https://mcp.example.com" },
            disabled: { url: "https://disabled.example.com", disabled: true },
            stdio: { command: "not-executed" },
          },
        }),
      );
      const mcp = yield* makeKiroMcp({
        instanceId: ProviderInstanceId.make("custom-home"),
        environment: { KIRO_HOME: home },
      });
      const methods = yield* mcp.methods;
      assert.lengthOf(methods, 1);
      assert.equal(methods[0]?.name, "workato MCP");
      assert.deepEqual(
        (yield* mcp.mcpServers).map(({ name, status, live }) => ({ name, status, live })),
        [
          { name: "workato MCP", status: "Not checked", live: false },
          { name: "disabled MCP", status: "Disabled", live: false },
          { name: "stdio MCP", status: "Not checked", live: false },
        ],
      );
      yield* fs.writeFileString(path.join(home, "settings", "mcp.json"), '{"mcpServers":{}}');
      yield* mcp.methods;
      assert.deepEqual(yield* mcp.mcpServers, []);
    }).pipe(Effect.scoped),
  );

  it.effect("reports every server and keeps live connections separate from the last check", () =>
    Effect.gen(function* () {
      const mcp = yield* makeMcp();
      const first = makePeer();
      const second = makePeer();
      let updates = 0;
      const onStatus = () =>
        Effect.sync(() => {
          updates++;
        });
      const a = yield* mcp.attach(first.runtime, { cwd: "/workspace", onStatus });
      const b = yield* mcp.attach(second.runtime, { cwd: "/workspace", onStatus });
      yield* first.status([
        { name: "workato", status: "connected", authType: "oauth" },
        { name: "glean", status: "failed", failedAuthorization: true },
        { name: "local", status: "failed", authType: "none", error: "private-native-error" },
        { name: "pending", status: "connecting" },
        { name: "offline", status: "disconnected" },
      ]);
      const summary = () =>
        mcp.mcpServers.pipe(
          Effect.map((servers) =>
            servers.map(({ name, status, live }) => ({ name, status, live })),
          ),
        );
      assert.deepEqual(
        (yield* summary()).map(({ status, live }) => [status, live]),
        [
          ["Connected", true],
          ["Authentication required", true],
          ["Connection failed", true],
          ["Connecting", true],
          ["Not connected", true],
        ],
      );
      assert.isFalse(JSON.stringify(yield* mcp.mcpServers).includes("private-native-error"));
      yield* second.status([{ name: "workato", status: "failed", failedAuthorization: true }]);
      assert.equal((yield* summary())[0]?.status, "Connected");
      yield* a.detach;
      assert.equal((yield* summary())[0]?.status, "Authentication required");
      assert.equal((yield* summary())[1]?.live, false);
      // Full snapshots replace a session's previous report.
      yield* second.status([]);
      assert.isFalse((yield* summary())[0]?.live);
      yield* second.status([{ name: "workato", status: "connected" }], "child");
      assert.isTrue((yield* summary())[0]?.live);
      yield* b.detach;
      assert.equal((yield* summary())[0]?.status, "Connected");
      assert.isFalse((yield* summary())[0]?.live);
      assert.equal(updates, 6);
      yield* mcp.clear;
      assert.equal((yield* summary())[0]?.status, "Not checked");
    }),
  );

  it.effect(
    "persists across runtimes, isolates instances, and deletes only the requested key",
    () =>
      Effect.gen(function* () {
        const mcp = yield* makeMcp();
        const first = makePeer();
        yield* mcp.attach(first.runtime, { cwd: "/workspace" });
        yield* Effect.all(
          [
            first.request("_kiro/secret/store", { key: "workato", value: "opaque-token" }),
            first.request("_kiro/secret/store", { key: "glean", value: "other-token" }),
          ],
          { concurrency: "unbounded" },
        );
        const second = makePeer();
        yield* (yield* makeMcp()).attach(second.runtime, { cwd: "/workspace" });
        assert.deepEqual(yield* second.request("_kiro/secret/get", { key: "workato" }), {
          value: "opaque-token",
        });
        assert.deepEqual(yield* second.request("_kiro/secret/get", { key: "glean" }), {
          value: "other-token",
        });
        assert.deepEqual(yield* second.request("_kiro/secret/get", { key: "constructor" }), {
          value: null,
        });
        yield* second.request("_kiro/secret/delete", { key: "workato" });
        assert.deepEqual(yield* first.request("_kiro/secret/get", { key: "workato" }), {
          value: null,
        });
        const other = makePeer();
        yield* (yield* makeMcp(ProviderInstanceId.make("another-kiro"))).attach(other.runtime, {
          cwd: "/workspace",
        });
        assert.deepEqual(yield* other.request("_kiro/secret/get", { key: "glean" }), {
          value: null,
        });
      }),
  );

  it.effect("does not overwrite corrupt stored credentials or accept invalid protocol inputs", () =>
    Effect.gen(function* () {
      const mcp = yield* makeMcp(ProviderInstanceId.make("corrupt-kiro"));
      yield* mcp.credentials.set(new TextEncoder().encode("broken-json"));
      const peer = makePeer();
      yield* mcp.attach(peer.runtime, { cwd: "/workspace" });
      assert.isTrue(
        (yield* peer
          .request("_kiro/secret/store", { key: "workato", value: "token" })
          .pipe(Effect.result))._tag === "Failure",
      );
      assert.isTrue(
        (yield* peer.request("_kiro/secret/store", { key: "", value: 1 }).pipe(Effect.result))
          ._tag === "Failure",
      );
      const stored = yield* mcp.credentials.get;
      assert.isTrue(
        stored._tag === "Some" && new TextDecoder().decode(stored.value) === "broken-json",
      );
    }),
  );

  it.effect(
    "waits for MCP initialization, explains auth failures, and replaces old snapshots",
    () =>
      Effect.gen(function* () {
        const mcp = yield* makeMcp();
        const peer = makePeer();
        const attached = yield* mcp.attach(peer.runtime, { cwd: "/workspace" });
        yield* peer.status([{ name: "workato", status: "connecting", authType: "oauth" }]);
        const prompt = yield* attached.runtime
          .prompt({ prompt: [{ type: "text", text: "Use Workato" }] })
          .pipe(Effect.forkChild);
        assert.lengthOf(peer.prompts, 0);
        yield* peer.status([
          { name: "workato", status: "failed", authType: "oauth", failedAuthorization: true },
        ]);
        yield* Fiber.join(prompt);
        assert.include(JSON.stringify(peer.prompts[0]), "authentication required");
        assert.include(JSON.stringify(peer.prompts[0]), "Settings > Providers > Kiro");
        assert.lengthOf(yield* mcp.methods, 1);
        yield* peer.status(
          [{ name: "workato", status: "connected", authType: "oauth" }],
          "child-session",
        );
        yield* attached.runtime.prompt({ prompt: [{ type: "text", text: "Use Workato again" }] });
        assert.include(JSON.stringify(peer.prompts[1]), "authentication required");
        yield* peer.status([]);
        yield* attached.runtime.prompt({ prompt: [{ type: "text", text: "Hello" }] });
        assert.deepEqual(peer.prompts[2]?.prompt, [{ type: "text", text: "Hello" }]);
      }),
  );

  it.effect("keeps equal server names in different workspaces distinct", () =>
    Effect.gen(function* () {
      const mcp = yield* makeMcp();
      for (const cwd of ["/first", "/second"]) {
        const peer = makePeer();
        yield* mcp.attach(peer.runtime, { cwd });
        yield* peer.status([{ name: "workato", status: "failed", authType: "oauth" }]);
      }
      const methods = yield* mcp.methods;
      assert.lengthOf(methods, 2);
      assert.notEqual(methods[0]?.id, methods[1]?.id);
    }),
  );

  it.effect(
    "signs in when resetServer is supported but unadvertised, saves credentials, and waits for connected status",
    () =>
      Effect.gen(function* () {
        const mcp = yield* makeMcp();
        const peer = makePeer();
        const initial = yield* mcp.attach(
          {
            ...peer.runtime,
            getModeState: Effect.succeed({ currentModeId: "custom-agent", availableModes: [] }),
          },
          { cwd: "/workspace" },
        );
        const modes: string[] = [];
        yield* peer.status([
          { name: "workato", status: "failed", authType: "oauth", failedAuthorization: true },
        ]);
        const resetStarted = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const callbacks: string[] = [];
        const auth = yield* makeKiroMcpAuth({
          mcp,
          makeRuntime: (cwd) =>
            Effect.succeed({
              ...peer.runtime,
              setMode: (mode) =>
                Effect.sync(() => {
                  modes.push(mode);
                  return {};
                }),
              start: () =>
                peer
                  .status([
                    {
                      name: "workato",
                      status: "failed",
                      authType: "oauth",
                      failedAuthorization: true,
                    },
                  ])
                  .pipe(
                    Effect.as({
                      sessionId: "session",
                      initializeResult,
                      sessionSetupResult: { sessionId: "session" },
                      modelConfigId: undefined,
                    }),
                  ),
              request: (method, params) =>
                Effect.gen(function* () {
                  assert.equal(cwd, "/workspace");
                  assert.equal(method, "_kiro/mcp/resetServer");
                  assert.deepEqual(params, {
                    sessionId: "session",
                    serverName: "workato",
                    startOAuth: true,
                  });
                  yield* Deferred.succeed(resetStarted, undefined);
                  const result = yield* peer.request("_kiro/openExternalUrl", {
                    url: "https://example.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2Fcallback&state=opaque",
                  });
                  assert.deepEqual(result, { success: true });
                  yield* peer.request("_kiro/secret/store", {
                    key: "workato",
                    value: "saved-token",
                  });
                  yield* Deferred.await(finish);
                  yield* peer.status([{ name: "workato", status: "connected", authType: "oauth" }]);
                  return {};
                }),
            }),
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                callbacks.push(request.url);
                return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
              }),
            ),
          ),
        );
        const method = (yield* mcp.methods)[0]!;
        yield* auth.start("client", Effect.void, method.id);
        yield* Deferred.await(resetStarted);
        const waiting = yield* auth.subscribe("client").pipe(
          Stream.filter((state) => state.phase === "waiting"),
          Stream.runHead,
        );
        assert.isTrue(waiting._tag === "Some");
        if (waiting._tag !== "Some") return;
        assert.equal(waiting.value.purpose, "mcp");
        assert.equal(waiting.value.interaction?.type, "browser");
        yield* auth.respond!("client", {
          instanceId,
          flowId: waiting.value.flowId!,
          interactionId: waiting.value.interaction!.id,
          response: { type: "browser", action: "accept" },
        });
        const callback = "http://127.0.0.1:43210/callback?code=secret&state=opaque";
        yield* auth.complete("client", { flowId: waiting.value.flowId!, callbackUrl: callback });
        assert.deepEqual(callbacks, [callback]);
        assert.deepEqual(modes, ["custom-agent"]);
        yield* Deferred.succeed(finish, undefined);
        const completed = yield* auth.subscribe("client").pipe(
          Stream.filter((state) => state.phase === "succeeded"),
          Stream.runHead,
        );
        assert.isTrue(completed._tag === "Some");
        assert.deepEqual(yield* peer.request("_kiro/secret/get", { key: "workato" }), {
          value: "saved-token",
        });
        assert.deepEqual(yield* SubscriptionRef.get(initial.status), [
          { name: "workato", status: "failed", authType: "oauth", failedAuthorization: true },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("propagates secret persistence failures to Kiro", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const stored = yield* host.credentials("kiro-mcp", "write-failure");
      const mcp = yield* makeMcp(ProviderInstanceId.make("write-failure")).pipe(
        Effect.provideService(ProviderHost.ProviderHost, {
          ...host,
          credentials: () =>
            Effect.succeed({
              ...stored,
              set: () =>
                Effect.fail(
                  new ProviderCredentialError({ operation: "set", cause: new Error("disk full") }),
                ),
            }),
        }),
      );
      const peer = makePeer();
      yield* mcp.attach(peer.runtime, { cwd: "/workspace" });
      assert.isTrue(
        (yield* peer
          .request("_kiro/secret/store", { key: "workato", value: "token" })
          .pipe(Effect.result))._tag === "Failure",
      );
      assert.deepEqual(yield* peer.request("_kiro/secret/get", { key: "workato" }), {
        value: null,
      });
    }),
  );

  it.effect("shares global MCP methods across projects using Kiro's provenance", () =>
    Effect.gen(function* () {
      const mcp = yield* makeMcp(ProviderInstanceId.make("global-kiro"));
      for (const cwd of ["/first", "/second"]) {
        const peer = makePeer();
        yield* mcp.attach(peer.runtime, { cwd });
        yield* peer.status([
          {
            name: "workato",
            status: "failed",
            authType: "oauth",
            _meta: {
              kiro: {
                resource: {
                  krn: "krn:user-local::mcp-server/settings/mcp.json#mcpServers/workato",
                },
              },
            },
          },
        ]);
      }
      assert.lengthOf(yield* mcp.methods, 1);
    }),
  );
  it.effect("reports unsupported sign-in only when Kiro rejects the method", () =>
    Effect.gen(function* () {
      const mcp = yield* makeMcp(ProviderInstanceId.make("unsupported-kiro"));
      const peer = makePeer();
      yield* mcp.attach(peer.runtime, { cwd: "/workspace" });
      yield* peer.status([{ name: "workato", status: "failed", authType: "oauth" }]);
      const auth = yield* makeKiroMcpAuth({
        mcp,
        makeRuntime: () =>
          Effect.succeed({
            ...peer.runtime,
            start: () =>
              peer.status([{ name: "workato", status: "failed", authType: "oauth" }]).pipe(
                Effect.as({
                  sessionId: "session",
                  initializeResult,
                  sessionSetupResult: { sessionId: "session" },
                  modelConfigId: undefined,
                }),
              ),
            request: () =>
              Effect.fail(
                new AcpErrors.AcpRequestError({ code: -32601, errorMessage: "Method not found" }),
              ),
          }),
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected HTTP request")),
        ),
      );
      yield* auth.start("client", Effect.void, (yield* mcp.methods)[0]!.id);
      const result = yield* auth.subscribe("client").pipe(
        Stream.filter((state) => state.phase === "failed"),
        Stream.runHead,
      );
      assert.isTrue(result._tag === "Some");
      if (result._tag === "Some")
        assert.equal(
          result.value.message,
          "This Kiro version does not support MCP sign-in over ACP.",
        );
    }).pipe(Effect.scoped),
  );

  it.effect("cancels the native sign-in process and reopens process admission", () =>
    Effect.gen(function* () {
      const mcp = yield* makeMcp(ProviderInstanceId.make("cancel-kiro"));
      const peer = makePeer();
      yield* mcp.attach(peer.runtime, { cwd: "/workspace" });
      yield* peer.status([{ name: "workato", status: "failed", authType: "oauth" }]);
      const started = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const auth = yield* makeKiroMcpAuth({
        mcp,
        makeRuntime: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
            return {
              ...peer.runtime,
              start: () =>
                peer.status([{ name: "workato", status: "failed", authType: "oauth" }]).pipe(
                  Effect.as({
                    sessionId: "session",
                    initializeResult,
                    sessionSetupResult: { sessionId: "session" },
                    modelConfigId: undefined,
                  }),
                ),
              request: () =>
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            };
          }),
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected HTTP request")),
        ),
      );
      const flow = yield* auth.start("client", Effect.void, (yield* mcp.methods)[0]!.id);
      yield* Deferred.await(started);
      assert.isTrue(
        (yield* auth.withAccess!(Effect.void).pipe(Effect.scoped, Effect.result))._tag ===
          "Failure",
      );
      const cancelled = yield* auth.cancel("client", flow.flowId!);
      assert.equal(cancelled.phase, "cancelled");
      yield* Deferred.await(closed);
      yield* auth.withAccess!(Effect.void);
    }).pipe(Effect.scoped),
  );
});

describe("Kiro MCP replay redaction", () => {
  it("removes authorization URLs, error text, and native metadata", () => {
    const recorded = kiroMcpStatusForRecording({
      sessionId: "session",
      authorizationUrl: "https://secret.example.com",
      servers: [
        {
          name: "workato",
          status: "failed",
          failedAuthorization: true,
          errorMessage: "token-secret",
          authorizationUrl: "https://secret.example.com",
          _meta: { credentials: "token-secret" },
        },
      ],
    });
    assert.deepEqual(recorded, {
      sessionId: "session",
      servers: [{ name: "workato", status: "failed", failedAuthorization: true }],
    });
    assert.isUndefined(kiroMcpStatusForRecording({ servers: "invalid" }));
  });
});

describe("Kiro MCP remote callbacks", () => {
  const authorization =
    "https://example.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2Fcallback&state=opaque";
  it("accepts only the current OAuth attempt's exact loopback callback", () => {
    const callback = "http://127.0.0.1:43210/callback?code=secret&state=opaque";
    assert.equal(kiroMcpCallbackUrl(authorization, callback), callback);
    for (const invalid of [
      callback.replace("127.0.0.1", "example.com"),
      callback.replace("43210", "43211"),
      callback.replace("/callback", "/other"),
      callback.replace("opaque", "different"),
      `${callback}&code=second`,
      `${callback}#fragment`,
      callback.replace("127.0.0.1", "user@127.0.0.1"),
    ])
      assert.isUndefined(kiroMcpCallbackUrl(authorization, invalid));
  });
});
