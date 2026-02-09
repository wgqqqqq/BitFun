/**
 * Cowork runtime bridge for FlowChat.
 *
 * Stores an in-memory mapping between FlowChat session and cowork session.
 * This allows:
 * - routing `cowork://...` events into the correct FlowChat dialog turn
 * - cancelling cowork from the existing cancel button (state machine USER_CANCEL)
 */

export interface CoworkRuntimeInfo {
  coworkSessionId: string;
  rootDialogTurnId: string;
  waitingTaskId?: string | null;
  mainTextItemId?: string;
  rosterById?: Record<string, { role: string; subagentType?: string; agentType?: string }>;
  taskToolItemIds?: Record<string, string>;
  taskMetaById?: Record<string, { title: string; description: string; assignee: string }>;
  unsubscribers?: Array<() => void>;
}

const runtimes = new Map<string, CoworkRuntimeInfo>();

export function setCoworkRuntime(flowChatSessionId: string, info: CoworkRuntimeInfo): void {
  runtimes.set(flowChatSessionId, info);
}

export function getCoworkRuntime(flowChatSessionId: string): CoworkRuntimeInfo | undefined {
  return runtimes.get(flowChatSessionId);
}

export function clearCoworkRuntime(flowChatSessionId: string): void {
  const rt = runtimes.get(flowChatSessionId);
  if (rt?.unsubscribers) {
    for (const u of rt.unsubscribers) {
      try {
        u();
      } catch {
        // ignore
      }
    }
  }
  runtimes.delete(flowChatSessionId);
}

export function setCoworkWaitingTask(flowChatSessionId: string, taskId: string | null): void {
  const rt = runtimes.get(flowChatSessionId);
  if (!rt) return;
  rt.waitingTaskId = taskId;
  runtimes.set(flowChatSessionId, rt);
}
