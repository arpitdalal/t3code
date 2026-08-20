import { describe, expect, it } from "@effect/vitest";

import {
  agentAwarenessNotificationIdentity,
  isNotifiableAgentAwarenessPhase,
  scopedThreadNotificationKey,
  shouldEmitAgentBrowserNotification,
  shouldSuppressAgentBrowserNotification,
} from "./browserNotifications.logic";

describe("browserNotifications.logic", () => {
  it("marks actionable agent phases as notifiable", () => {
    expect(isNotifiableAgentAwarenessPhase("waiting_for_input")).toBe(true);
    expect(isNotifiableAgentAwarenessPhase("waiting_for_approval")).toBe(true);
    expect(isNotifiableAgentAwarenessPhase("completed")).toBe(true);
    expect(isNotifiableAgentAwarenessPhase("failed")).toBe(true);
    expect(isNotifiableAgentAwarenessPhase("running")).toBe(false);
    expect(isNotifiableAgentAwarenessPhase("starting")).toBe(false);
  });

  it("suppresses notifications while the target thread is focused", () => {
    const key = scopedThreadNotificationKey("env-1", "thread-1");
    expect(
      shouldSuppressAgentBrowserNotification({
        documentHidden: false,
        windowFocused: true,
        activeThreadKey: key,
        targetThreadKey: key,
      }),
    ).toBe(true);
    expect(
      shouldSuppressAgentBrowserNotification({
        documentHidden: true,
        windowFocused: true,
        activeThreadKey: key,
        targetThreadKey: key,
      }),
    ).toBe(false);
    expect(
      shouldSuppressAgentBrowserNotification({
        documentHidden: false,
        windowFocused: true,
        activeThreadKey: scopedThreadNotificationKey("env-1", "thread-2"),
        targetThreadKey: key,
      }),
    ).toBe(false);
  });

  it("emits only on seeded notifiable transitions", () => {
    const identity = agentAwarenessNotificationIdentity({
      phase: "completed",
      headline: "Agent finished",
      detail: "Review the completed task.",
      threadId: "thread-1",
    });

    expect(
      shouldEmitAgentBrowserNotification({
        seeded: false,
        previousIdentity: null,
        nextIdentity: identity,
        phase: "completed",
      }),
    ).toBe(false);

    expect(
      shouldEmitAgentBrowserNotification({
        seeded: true,
        previousIdentity: undefined,
        nextIdentity: identity,
        phase: "completed",
      }),
    ).toBe(false);

    expect(
      shouldEmitAgentBrowserNotification({
        seeded: true,
        previousIdentity: null,
        nextIdentity: identity,
        phase: "completed",
      }),
    ).toBe(true);

    expect(
      shouldEmitAgentBrowserNotification({
        seeded: true,
        previousIdentity: identity,
        nextIdentity: identity,
        phase: "completed",
      }),
    ).toBe(false);
  });
});
