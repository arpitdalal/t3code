import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderAuthState } from "./providerSetup.ts";

const decodeState = Schema.decodeUnknownSync(ProviderAuthState);

describe("provider auth state", () => {
  it("drops auth variants from newer servers instead of rejecting the state", () => {
    const method = { id: "browser", name: "Browser", description: null, type: "agent" };
    expect(
      decodeState({
        instanceId: "cursor",
        phase: "waiting",
        flowId: null,
        authorizationUrl: null,
        expiresAt: null,
        message: null,
        methods: [method, { ...method, id: "passkey", type: "passkey" }],
        interaction: { type: "passkey", id: "passkey" },
        credentialOwner: "keychain",
        mcpServers: [
          { id: "workato", name: "Workato", status: "Connected", live: true },
          { id: "future", name: "Future", status: "future-state", live: true },
        ],
      }),
    ).toEqual({
      instanceId: "cursor",
      phase: "waiting",
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: null,
      methods: [method],
      mcpServers: [{ id: "workato", name: "Workato", status: "Connected", live: true }],
    });
  });
});
