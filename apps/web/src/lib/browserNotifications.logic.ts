import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";

export const NOTIFIABLE_AGENT_AWARENESS_PHASES = new Set<AgentAwarenessPhase>([
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
]);

export function isNotifiableAgentAwarenessPhase(phase: AgentAwarenessPhase): boolean {
  return NOTIFIABLE_AGENT_AWARENESS_PHASES.has(phase);
}

export function agentAwarenessNotificationIdentity(state: {
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly detail?: string | undefined;
  readonly threadId: string;
}): string {
  return JSON.stringify({
    phase: state.phase,
    headline: state.headline,
    detail: state.detail ?? null,
    threadId: state.threadId,
  });
}

export function scopedThreadNotificationKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

export function shouldSuppressAgentBrowserNotification(input: {
  readonly documentHidden: boolean;
  readonly windowFocused: boolean;
  readonly activeThreadKey: string | null;
  readonly targetThreadKey: string;
}): boolean {
  if (input.documentHidden) {
    return false;
  }
  if (input.activeThreadKey !== input.targetThreadKey) {
    return false;
  }
  return input.windowFocused;
}

export function shouldEmitAgentBrowserNotification(input: {
  readonly seeded: boolean;
  readonly previousIdentity: string | null | undefined;
  readonly nextIdentity: string | null;
  readonly phase: AgentAwarenessPhase | null;
}): boolean {
  if (!input.seeded) {
    return false;
  }
  if (input.previousIdentity === undefined) {
    return false;
  }
  if (input.nextIdentity === null || input.nextIdentity === input.previousIdentity) {
    return false;
  }
  if (input.phase === null) {
    return false;
  }
  return isNotifiableAgentAwarenessPhase(input.phase);
}
