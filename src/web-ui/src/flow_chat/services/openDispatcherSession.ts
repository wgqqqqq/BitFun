import { flowChatStore } from '../store/FlowChatStore';
import { flowChatManager } from './FlowChatManager';
import { openMainSession } from './openBtwSession';

export interface OpenDispatcherSessionOptions {
  /** Assistant workspace used when creating a new Dispatcher session if none exists. */
  assistantWorkspace?: { rootPath: string; id: string } | null;
}

/**
 * Focuses the latest Agentic OS (Dispatcher) session, or creates one if missing.
 * Mirrors the nav "Agentic OS" entry behavior.
 */
export async function openDispatcherSession(
  options?: OpenDispatcherSessionOptions
): Promise<void> {
  const storeState = flowChatStore.getState();
  const existing =
    Array.from(storeState.sessions.values())
      .filter((s) => s.mode === 'Dispatcher')
      .sort(
        (a, b) =>
          (b.lastActiveAt ?? b.createdAt ?? 0) - (a.lastActiveAt ?? a.createdAt ?? 0)
      )[0] ?? null;

  if (existing) {
    await openMainSession(existing.sessionId);
    return;
  }

  const globalWs = options?.assistantWorkspace;
  if (globalWs) {
    await flowChatManager.createChatSession(
      { workspacePath: globalWs.rootPath, workspaceId: globalWs.id },
      'Dispatcher'
    );
  } else {
    await flowChatManager.createChatSession({}, 'Dispatcher');
  }
}
