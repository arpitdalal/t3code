import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";

export type BrowserNotificationPermissionState = NotificationPermission | "unsupported";

export function isBrowserNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function readBrowserNotificationPermission(): BrowserNotificationPermissionState {
  if (!isBrowserNotificationSupported()) {
    return "unsupported";
  }
  return Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermissionState> {
  if (!isBrowserNotificationSupported()) {
    return "unsupported";
  }
  if (Notification.permission === "granted") {
    return "granted";
  }
  if (Notification.permission === "denied") {
    return "denied";
  }
  return Notification.requestPermission();
}

export function buildAgentBrowserNotificationContent(state: AgentAwarenessState): {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
} {
  const projectLabel = state.projectTitle.trim();
  const threadLabel = state.threadTitle.trim();
  const title = projectLabel.length > 0 ? `${state.headline} · ${projectLabel}` : state.headline;
  const body =
    state.detail?.trim() ||
    (threadLabel.length > 0 ? threadLabel : `${state.modelTitle} on ${state.phase}`);
  return {
    title,
    body,
    tag: `${state.environmentId}:${state.threadId}:${state.phase}`,
  };
}

export function showAgentBrowserNotification(input: {
  readonly state: AgentAwarenessState;
  readonly onNavigate: () => void;
}): void {
  if (!isBrowserNotificationSupported() || Notification.permission !== "granted") {
    return;
  }

  const content = buildAgentBrowserNotificationContent(input.state);
  const notification = new Notification(content.title, {
    body: content.body,
    tag: content.tag,
    silent: false,
  });

  notification.onclick = () => {
    window.focus();
    input.onNavigate();
    notification.close();
  };
}
