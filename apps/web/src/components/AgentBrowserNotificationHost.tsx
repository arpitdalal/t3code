import { useNavigate, useParams } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import { useEffect, useMemo, useRef } from "react";

import { useClientSettings, useClientSettingsHydrated } from "~/hooks/useSettings";
import { buildThreadRouteParams, resolveThreadRouteRef } from "~/threadRoutes";
import { useProjects, useThreadShells } from "~/state/entities";
import {
  agentAwarenessNotificationIdentity,
  scopedThreadNotificationKey,
  shouldEmitAgentBrowserNotification,
  shouldSuppressAgentBrowserNotification,
} from "~/lib/browserNotifications.logic";
import {
  readBrowserNotificationPermission,
  showAgentBrowserNotification,
} from "~/lib/browserNotifications";

export function AgentBrowserNotificationHost() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const enabled = useClientSettings((settings) => settings.browserAgentNotificationsEnabled);
  const settingsHydrated = useClientSettingsHydrated();
  const threadShells = useThreadShells();
  const projects = useProjects();
  const activeThreadRef = useMemo(() => resolveThreadRouteRef(params), [params]);
  const activeThreadKey =
    activeThreadRef === null
      ? null
      : scopedThreadNotificationKey(activeThreadRef.environmentId, activeThreadRef.threadId);

  const previousIdentitiesRef = useRef<Map<string, string | null>>(new Map());
  const seededRef = useRef(false);

  const projectTitleByRef = useMemo(() => {
    const titles = new Map<string, string>();
    for (const project of projects) {
      titles.set(`${project.environmentId}:${project.id}`, project.title);
    }
    return titles;
  }, [projects]);

  useEffect(() => {
    if (!settingsHydrated || !enabled) {
      seededRef.current = false;
      previousIdentitiesRef.current.clear();
      return;
    }
    if (readBrowserNotificationPermission() !== "granted") {
      return;
    }

    const documentHidden = document.hidden;
    const windowFocused = document.hasFocus();
    const seeded = seededRef.current;

    for (const shell of threadShells) {
      const threadKey = scopedThreadNotificationKey(shell.environmentId, shell.id);
      const awareness = projectThreadAwareness({
        environmentId: shell.environmentId,
        project: {
          title: projectTitleByRef.get(`${shell.environmentId}:${shell.projectId}`) ?? "",
        },
        thread: shell,
      });
      const nextIdentity = awareness
        ? agentAwarenessNotificationIdentity({
            phase: awareness.phase,
            headline: awareness.headline,
            detail: awareness.detail,
            threadId: awareness.threadId,
          })
        : null;
      const previousIdentity = previousIdentitiesRef.current.get(threadKey);

      if (
        shouldEmitAgentBrowserNotification({
          seeded,
          previousIdentity,
          nextIdentity,
          phase: awareness?.phase ?? null,
        }) &&
        awareness !== null &&
        !shouldSuppressAgentBrowserNotification({
          documentHidden,
          windowFocused,
          activeThreadKey,
          targetThreadKey: threadKey,
        })
      ) {
        showAgentBrowserNotification({
          state: awareness,
          onNavigate: () => {
            const threadRef = scopeThreadRef(shell.environmentId, shell.id);
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(threadRef),
            });
          },
        });
      }

      previousIdentitiesRef.current.set(threadKey, nextIdentity);
    }

    seededRef.current = true;
  }, [activeThreadKey, enabled, projectTitleByRef, navigate, settingsHydrated, threadShells]);

  return null;
}
