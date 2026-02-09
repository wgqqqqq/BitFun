/**
 * Message handling module
 * Handles message sending, cancellation, and other operations
 */

import { FlowChatStore } from '../../store/FlowChatStore';
import { agentAPI } from '@/infrastructure/api';
import { CoworkAPI } from '@/infrastructure/api/service-api/CoworkAPI';
import { aiExperienceConfigService } from '@/infrastructure/config/services';
import { notificationService } from '../../../shared/notification-system';
import { stateMachineManager } from '../../state-machine';
import { SessionExecutionEvent, SessionExecutionState } from '../../state-machine/types';
import { generateTempTitle } from '../../utils/titleUtils';
import { createLogger } from '@/shared/utils/logger';
import type { FlowChatContext, DialogTurn, ModelRound, FlowTextItem } from './types';
import { ensureBackendSession, retryCreateBackendSession } from './SessionModule';
import { cleanupSessionBuffers } from './TextChunkModule';
import { debouncedSaveDialogTurn, immediateSaveDialogTurn, saveDialogTurnToDisk } from './PersistenceModule';
import { clearCoworkRuntime, getCoworkRuntime, setCoworkRuntime, setCoworkWaitingTask } from '../coworkRuntime';

interface CoworkTaskLike {
  id: string;
  title?: string;
  description?: string;
  assignee?: string;
  state?: string;
  deps?: string[];
  outputText?: string;
  error?: string | null;
}

interface CoworkEventLike {
  coworkSessionId?: string;
  taskId?: string;
  state?: string;
  assignee?: string;
  outputText?: string;
  error?: string | null;
  questions?: string[];
  tasks?: CoworkTaskLike[];
  roster?: Array<{ id: string; role?: string; subagentType?: string; agentType?: string }>;
  taskOrder?: string[];
}

const COWORK_TEXT_SOURCE = 'cowork-main';

function openCoworkDagTab(coworkSessionId: string): void {
  const tabInfo = {
    type: 'cowork-dag',
    title: 'Cowork DAG',
    data: {
      coworkSessionId,
      autoListen: true,
    },
    metadata: {
      duplicateCheckKey: `cowork-dag:${coworkSessionId}`,
      coworkSessionId,
    },
    checkDuplicate: true,
    duplicateCheckKey: `cowork-dag:${coworkSessionId}`,
    replaceExisting: true,
  };

  window.dispatchEvent(new CustomEvent('agent-create-tab', { detail: tabInfo }));
  window.dispatchEvent(new CustomEvent('expand-right-panel'));
}

function buildCoworkMainText(args: {
  goal: string;
  coworkSessionId?: string;
  sessionState?: string;
  tasks?: Array<{ title?: string; assignee?: string }>;
  rosterById?: Record<string, { role: string; subagentType?: string; agentType?: string }>;
  waitingTaskId?: string | null;
  questions?: string[];
  phaseHint?: string;
}): string {
  const lines: string[] = [];
  lines.push('## Cowork Plan');
  lines.push('');
  lines.push('Goal:');
  lines.push('');
  lines.push(args.goal);
  lines.push('');

  if (args.coworkSessionId) {
    lines.push(`Session: \`${args.coworkSessionId}\``);
  }
  if (args.sessionState) {
    lines.push(`State: **${args.sessionState}**`);
  }
  if (args.phaseHint) {
    lines.push(`Progress: ${args.phaseHint}`);
  }
  lines.push('');

  if (Array.isArray(args.tasks) && args.tasks.length > 0) {
    const rosterById = args.rosterById || {};
    const taskLines = args.tasks.slice(0, 12).map((t, i) => {
      const assigneeId = t.assignee || 'unknown';
      const assigneeLabel = formatAssigneeLabel(assigneeId, rosterById);
      return `- ${i + 1}. **${t.title || '(untitled)'}** · ${assigneeLabel}`;
    });
    lines.push('### Task Breakdown');
    lines.push(...taskLines);
    if (args.tasks.length > 12) {
      lines.push(`- …and ${args.tasks.length - 12} more`);
    }
    lines.push('');
  }

  if (args.waitingTaskId && Array.isArray(args.questions) && args.questions.length > 0) {
    lines.push('### Needs your input');
    lines.push(`Task \`${args.waitingTaskId}\` asks:`);
    lines.push(...args.questions.map(q => `- ${q}`));
    lines.push('');
    lines.push('Reply in chat with your answers (one per line).');
    lines.push('');
  }

  return lines.join('\n');
}

function upsertCoworkMainText(
  context: FlowChatContext,
  flowChatSessionId: string,
  dialogTurnId: string,
  roundId: string,
  markdown: string,
  status: FlowTextItem['status']
): void {
  const rt = getCoworkRuntime(flowChatSessionId);
  if (!rt) return;

  const existingId = rt.mainTextItemId;
  if (existingId) {
    context.flowChatStore.updateModelRoundItem(flowChatSessionId, dialogTurnId, existingId, {
      content: markdown,
      status,
      isStreaming: false,
      isMarkdown: true,
      metadata: { source: COWORK_TEXT_SOURCE },
      timestamp: Date.now(),
    } as any);
    return;
  }

  const id = `cowork_main_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  setCoworkRuntime(flowChatSessionId, { ...rt, mainTextItemId: id });
  context.flowChatStore.addModelRoundItem(
    flowChatSessionId,
    dialogTurnId,
    {
      id,
      type: 'text',
      content: markdown,
      isStreaming: false,
      isMarkdown: true,
      timestamp: Date.now(),
      status,
      metadata: { source: COWORK_TEXT_SOURCE },
    } as any,
    roundId
  );
}

function buildRosterById(
  roster: Array<{ id: string; role?: string; subagentType?: string; agentType?: string }> | undefined
): Record<string, { role: string; subagentType?: string; agentType?: string }> {
  if (!Array.isArray(roster)) {
    return {};
  }

  const byId: Record<string, { role: string; subagentType?: string; agentType?: string }> = {};
  for (const member of roster) {
    if (!member?.id) continue;
    byId[member.id] = {
      role: member.role || member.id,
      subagentType: member.subagentType,
      agentType: member.agentType,
    };
  }
  return byId;
}

function formatAssigneeLabel(
  assigneeId: string,
  rosterById?: Record<string, { role: string; subagentType?: string; agentType?: string }>
): string {
  const member = rosterById?.[assigneeId];
  if (!member) return assigneeId;
  if (member.agentType) {
    return `${member.role} (${member.agentType})`;
  }
  if (member.subagentType) {
    return `${member.role} (${member.subagentType})`;
  }
  return member.role;
}

function upsertCoworkTaskCard(
  context: FlowChatContext,
  flowChatSessionId: string,
  dialogTurnId: string,
  roundId: string,
  task: CoworkTaskLike,
  taskState: string,
  runtimeData: {
    taskToolItemIds: Record<string, string>;
    taskMetaById: Record<string, { title: string; description: string; assignee: string }>;
    rosterById: Record<string, { role: string; subagentType?: string; agentType?: string }>;
  }
): void {
  if (!task?.id) return;

  const existingId = runtimeData.taskToolItemIds[task.id];
  const title = task.title || runtimeData.taskMetaById[task.id]?.title || task.id;
  const description = task.description || runtimeData.taskMetaById[task.id]?.description || title;
  const assignee = task.assignee || runtimeData.taskMetaById[task.id]?.assignee || 'unknown';

  runtimeData.taskMetaById[task.id] = {
    title,
    description,
    assignee,
  };

  const mappedStatus =
    taskState === 'failed' || taskState === 'error'
      ? 'error'
      : taskState === 'cancelled'
        ? 'cancelled'
        : taskState === 'completed'
          ? 'completed'
          : taskState === 'waiting_user_input'
            ? 'pending_confirmation'
            : 'running';

  const toolItemBase: any = {
    type: 'tool',
    toolName: 'Task',
    timestamp: Date.now(),
    status: mappedStatus,
    toolCall: {
      id: `cowork-task-call-${task.id}`,
      input: {
        description: title,
        prompt: description,
        subagent_type: formatAssigneeLabel(assignee, runtimeData.rosterById),
      },
    },
    toolResult:
      taskState === 'completed' || taskState === 'failed' || taskState === 'error'
        ? {
            success: taskState === 'completed',
            result: {
              state: taskState,
              output: task.outputText || '',
              error: task.error || undefined,
            },
          }
        : undefined,
    metadata: {
      source: COWORK_TEXT_SOURCE,
      coworkTaskId: task.id,
      assignee,
      assigneeLabel: formatAssigneeLabel(assignee, runtimeData.rosterById),
    },
  };

  if (existingId) {
    context.flowChatStore.updateModelRoundItem(
      flowChatSessionId,
      dialogTurnId,
      existingId,
      {
        ...toolItemBase,
        id: existingId,
      } as any
    );
    return;
  }

  const toolItemId = `cowork_task_tool_${task.id}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  runtimeData.taskToolItemIds[task.id] = toolItemId;
  context.flowChatStore.addModelRoundItem(
    flowChatSessionId,
    dialogTurnId,
    {
      ...toolItemBase,
      id: toolItemId,
    } as any,
    roundId
  );
}

const log = createLogger('MessageModule');

/**
 * Send message and handle response
 * @param message - Message sent to backend
 * @param sessionId - Session ID
 * @param displayMessage - Optional, message for UI display
 * @param agentType - Agent type
 * @param switchToMode - Optional, switch UI mode selector to this mode (if not provided, mode remains unchanged)
 */
export async function sendMessage(
  context: FlowChatContext,
  message: string,
  sessionId: string,
  displayMessage?: string,
  agentType?: string,
  switchToMode?: string
): Promise<void> {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session does not exist: ${sessionId}`);
  }

  // Switch UI mode if specified
  if (switchToMode && switchToMode !== session.mode) {
    context.flowChatStore.updateSessionMode(sessionId, switchToMode);
    window.dispatchEvent(new CustomEvent('bitfun:session-switched', {
      detail: { sessionId, mode: switchToMode }
    }));
  }

  try {
    const isFirstMessage = session.dialogTurns.length === 0 && session.titleStatus !== 'generated';
    
    const dialogTurnId = `dialog_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const dialogTurn: DialogTurn = {
      id: dialogTurnId,
      sessionId: sessionId,
      userMessage: {
        id: `user_${Date.now()}`,
        content: displayMessage || message,
        timestamp: Date.now()
      },
      modelRounds: [],
      status: 'pending',
      startTime: Date.now()
    };

    context.flowChatStore.addDialogTurn(sessionId, dialogTurn);
    
    await stateMachineManager.transition(sessionId, SessionExecutionEvent.START, {
      taskId: sessionId,
      dialogTurnId,
    });

    if (isFirstMessage) {
      handleTitleGeneration(context, sessionId, message);
    }

    context.processingManager.registerStatus({
      sessionId: sessionId,
      status: 'thinking',
      message: '',
      metadata: { sessionId: sessionId, dialogTurnId }
    });

    const updatedSession = context.flowChatStore.getState().sessions.get(sessionId);
    if (!updatedSession) {
      throw new Error(`Session lost after adding dialog turn: ${sessionId}`);
    }
    
    const currentAgentType = agentType || 'agentic';

    // Frontend-integrated cowork mode: route to CoworkAPI and render everything in FlowChat.
    if (currentAgentType === 'cowork') {
      await sendCoworkMessage(context, sessionId, dialogTurnId, message, displayMessage || message, isFirstMessage);
      return;
    }

    try {
      await ensureBackendSession(context, sessionId);
    } catch (createError: any) {
      log.warn('Backend session create/restore failed', { sessionId: sessionId, error: createError });
    }
    
    context.contentBuffers.set(sessionId, new Map());
    context.activeTextItems.set(sessionId, new Map());

    let turnResponse;
    try {
      turnResponse = await agentAPI.startDialogTurn({
        sessionId: sessionId,
        userInput: message,
        turnId: dialogTurnId,
        agentType: currentAgentType,
      });
    } catch (error: any) {
      if (error?.message?.includes('Session does not exist') || error?.message?.includes('Not found')) {
        log.warn('Backend session still not found, retrying creation', {
          sessionId: sessionId,
          dialogTurnsCount: updatedSession.dialogTurns.length
        });
        
        await retryCreateBackendSession(context, sessionId);
        
        turnResponse = await agentAPI.startDialogTurn({
          sessionId: sessionId,
          userInput: message,
          turnId: dialogTurnId,
          agentType: currentAgentType,
        });
      } else {
        throw error;
      }
    }

    const sessionStateMachine = stateMachineManager.get(sessionId);
    if (sessionStateMachine) {
      sessionStateMachine.getContext().taskId = sessionId;
    }

  } catch (error) {
    log.error('Failed to send message', { sessionId: sessionId, error });
    
    const errorMessage = error instanceof Error ? error.message : 'Failed to send message';
    
    const currentState = stateMachineManager.getCurrentState(sessionId);
    if (currentState === SessionExecutionState.PROCESSING) {
      stateMachineManager.transition(sessionId, SessionExecutionEvent.ERROR_OCCURRED, {
        error: errorMessage
      });
    }
    
    const state = context.flowChatStore.getState();
    const currentSession = state.sessions.get(sessionId);
    if (currentSession && currentSession.dialogTurns.length > 0) {
      const lastDialogTurn = currentSession.dialogTurns[currentSession.dialogTurns.length - 1];
      context.flowChatStore.deleteDialogTurn(sessionId, lastDialogTurn.id);
    }
    
    notificationService.error(errorMessage, {
      title: 'Thinking process error',
      duration: 5000
    });
    
    throw error;
  }
}

async function sendCoworkMessage(
  context: FlowChatContext,
  flowChatSessionId: string,
  dialogTurnId: string,
  rawMessage: string,
  displayMessage: string,
  isFirstMessage: boolean
): Promise<void> {
  if (isFirstMessage) {
    handleTitleGeneration(context, flowChatSessionId, rawMessage);
  }

  // Create a synthetic model round for cowork output.
  const roundId = `cowork_round_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const modelRound: ModelRound = {
    id: roundId,
    index: 0,
    items: [],
    isStreaming: true,
    isComplete: false,
    status: 'streaming',
    startTime: Date.now(),
  };
  context.flowChatStore.addModelRound(flowChatSessionId, dialogTurnId, modelRound);

  // Create a single main text block and keep updating it (no line-by-line spam).
  setCoworkRuntime(flowChatSessionId, {
    ...(getCoworkRuntime(flowChatSessionId) || ({} as any)),
    coworkSessionId: getCoworkRuntime(flowChatSessionId)?.coworkSessionId || '',
    rootDialogTurnId: dialogTurnId,
  } as any);
  upsertCoworkMainText(
    context,
    flowChatSessionId,
    dialogTurnId,
    roundId,
    buildCoworkMainText({ goal: displayMessage, phaseHint: 'Initializing…' }),
    'running'
  );

  // If we are currently waiting for HITL, treat this message as answers submission.
  const existing = getCoworkRuntime(flowChatSessionId);
  if (existing?.coworkSessionId && existing.waitingTaskId) {
    const answers = rawMessage
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    upsertCoworkMainText(
      context,
      flowChatSessionId,
      dialogTurnId,
      roundId,
      buildCoworkMainText({
        goal: displayMessage,
        coworkSessionId: existing.coworkSessionId,
        sessionState,
        phaseHint: `Submitting answers for \`${existing.waitingTaskId}\`…`,
      }),
      'running'
    );
    await CoworkAPI.submitUserInput(existing.coworkSessionId, existing.waitingTaskId, answers);
    setCoworkWaitingTask(flowChatSessionId, null);
    upsertCoworkMainText(
      context,
      flowChatSessionId,
      dialogTurnId,
      roundId,
      buildCoworkMainText({
        goal: displayMessage,
        coworkSessionId: existing.coworkSessionId,
        sessionState,
        phaseHint: 'Answers submitted. Continuing…',
      }),
      'completed'
    );
    context.flowChatStore.updateDialogTurn(flowChatSessionId, dialogTurnId, turn => ({
      ...turn,
      status: 'completed',
      endTime: Date.now(),
    }));
    stateMachineManager.transition(flowChatSessionId, SessionExecutionEvent.STREAM_COMPLETE);
    saveDialogTurnToDisk(context, flowChatSessionId, dialogTurnId).catch(() => {});
    return;
  }

  // Start a new cowork session for this message.
  const { coworkSessionId } = await CoworkAPI.createSession({ goal: rawMessage });
  setCoworkRuntime(flowChatSessionId, {
    coworkSessionId,
    rootDialogTurnId: dialogTurnId,
    waitingTaskId: null,
    rosterById: {},
    taskToolItemIds: {},
    taskMetaById: {},
    unsubscribers: [],
  });
  openCoworkDagTab(coworkSessionId);

  upsertCoworkMainText(
    context,
    flowChatSessionId,
    dialogTurnId,
    roundId,
    buildCoworkMainText({
      goal: displayMessage,
      coworkSessionId,
      sessionState: 'draft',
      phaseHint: 'Generating plan…',
    }),
    'running'
  );

  // Register listeners: append cowork events into the *root* dialog turn.
  const store = FlowChatStore.getInstance();
  const ensureRootRound = (): string => {
    const rt = getCoworkRuntime(flowChatSessionId);
    if (!rt) return roundId;
    const s = store.getState().sessions.get(flowChatSessionId);
    const turn = s?.dialogTurns.find(t => t.id === rt.rootDialogTurnId);
    const lastRound = turn?.modelRounds[turn.modelRounds.length - 1];
    if (lastRound) return lastRound.id;
    // fallback: create one
    const rid = `cowork_round_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    store.addModelRound(flowChatSessionId, rt.rootDialogTurnId, {
      id: rid,
      index: 0,
      items: [],
      isStreaming: true,
      isComplete: false,
      status: 'streaming',
      startTime: Date.now(),
    });
    return rid;
  };

  const addToRoot = (
    markdown: string,
    status: FlowTextItem['status'] = 'completed',
    metadata: Record<string, any> = {}
  ) => {
    const rt = getCoworkRuntime(flowChatSessionId);
    if (!rt) return;
    const rid = ensureRootRound();
    appendText(context, flowChatSessionId, rt.rootDialogTurnId, rid, markdown, status, {
      source: COWORK_TEXT_SOURCE,
      ...metadata,
    });
    debouncedSaveDialogTurn(context, flowChatSessionId, rt.rootDialogTurnId, 800);
  };

  const renderPlanSummary = (payload: CoworkEventLike) => {
    const rt = getCoworkRuntime(flowChatSessionId);
    if (!rt) return;

    const rosterById = buildRosterById(payload.roster) || rt.rosterById || {};
    const taskToolItemIds = rt.taskToolItemIds || {};
    const taskMetaById = rt.taskMetaById || {};
    const orderedTasks = Array.isArray(payload.tasks) ? payload.tasks : [];

    for (const task of orderedTasks) {
      taskMetaById[task.id] = {
        title: task.title || task.id,
        description: task.description || task.title || task.id,
        assignee: task.assignee || 'unknown',
      };

      upsertCoworkTaskCard(context, flowChatSessionId, rt.rootDialogTurnId, ensureRootRound(), task, task.state || 'ready', {
        taskToolItemIds,
        taskMetaById,
        rosterById,
      });
    }

    setCoworkRuntime(flowChatSessionId, {
      ...rt,
      rosterById,
      taskToolItemIds,
      taskMetaById,
    });

    upsertCoworkMainText(
      context,
      flowChatSessionId,
      rt.rootDialogTurnId,
      ensureRootRound(),
      buildCoworkMainText({
        goal: displayMessage,
        coworkSessionId,
        sessionState: 'ready',
        tasks: orderedTasks.map(t => ({ title: t.title, assignee: t.assignee })),
        rosterById,
        phaseHint: 'Plan ready. Starting execution…',
      }),
      'completed'
    );
  };

  const finalizeRoot = (ok: boolean, errorMessage?: string) => {
    const rt = getCoworkRuntime(flowChatSessionId);
    if (!rt) return;
    const rid = ensureRootRound();

    store.updateDialogTurn(flowChatSessionId, rt.rootDialogTurnId, turn => {
      const updatedRounds = turn.modelRounds.map(r => r.id === rid ? ({
        ...r,
        isStreaming: false,
        isComplete: true,
        status: ok ? 'completed' : 'error',
        endTime: Date.now(),
      }) : r);
      return {
        ...turn,
        modelRounds: updatedRounds,
        status: ok ? 'completed' : 'error',
        error: ok ? undefined : (errorMessage || 'Cowork failed'),
        endTime: Date.now(),
      };
    });

    if (ok) {
      stateMachineManager.transition(flowChatSessionId, SessionExecutionEvent.STREAM_COMPLETE);
    } else {
      stateMachineManager.transition(flowChatSessionId, SessionExecutionEvent.ERROR_OCCURRED, { error: errorMessage || 'Cowork failed' });
      stateMachineManager.transition(flowChatSessionId, SessionExecutionEvent.RESET);
    }

    immediateSaveDialogTurn(context, flowChatSessionId, rt.rootDialogTurnId);
    saveDialogTurnToDisk(context, flowChatSessionId, rt.rootDialogTurnId).catch(() => {});
    clearCoworkRuntime(flowChatSessionId);
  };

  const unsubs = [
    CoworkAPI.onSessionCreated((p: CoworkEventLike) => {
      if (p?.coworkSessionId !== coworkSessionId) return;
      const rt = getCoworkRuntime(flowChatSessionId);
      if (!rt) return;
      setCoworkRuntime(flowChatSessionId, {
        ...rt,
        rosterById: buildRosterById(p.roster),
      });
    }),
    CoworkAPI.onPlanGenerated((p: CoworkEventLike) => {
      if (p?.coworkSessionId !== coworkSessionId) return;
      renderPlanSummary(p);
    }),
    CoworkAPI.onPlanUpdated((p: CoworkEventLike) => {
      if (p?.coworkSessionId !== coworkSessionId) return;
      renderPlanSummary(p);
    }),
    CoworkAPI.onTaskStateChanged((p: CoworkEventLike) => {
      if (p?.coworkSessionId !== coworkSessionId) return;

      const rt = getCoworkRuntime(flowChatSessionId);
      if (rt?.taskMetaById && p.taskId) {
        const meta = rt.taskMetaById[p.taskId] || {
          title: p.taskId,
          description: p.taskId,
          assignee: p.assignee || 'unknown',
        };
        upsertCoworkTaskCard(
          context,
          flowChatSessionId,
          rt.rootDialogTurnId,
          ensureRootRound(),
          {
            id: p.taskId,
            title: meta.title,
            description: meta.description,
            assignee: p.assignee || meta.assignee,
            state: p.state,
            error: p.error || null,
          },
          p.state || 'running',
          {
            taskToolItemIds: rt.taskToolItemIds || {},
            taskMetaById: rt.taskMetaById || {},
            rosterById: rt.rosterById || {},
          }
        );
      }

      // Do not spam FlowChat with per-task progress lines.
    }),
    CoworkAPI.onTaskOutput((p: CoworkEventLike) => {
      if (p?.coworkSessionId !== coworkSessionId) return;

      const rt = getCoworkRuntime(flowChatSessionId);
      if (rt?.taskMetaById && p.taskId) {
        const meta = rt.taskMetaById[p.taskId] || {
          title: p.taskId,
          description: p.taskId,
          assignee: 'unknown',
        };
        upsertCoworkTaskCard(
          context,
          flowChatSessionId,
          rt.rootDialogTurnId,
          ensureRootRound(),
          {
            id: p.taskId,
            title: meta.title,
            description: meta.description,
            assignee: meta.assignee,
            state: 'completed',
            outputText: p.outputText || '',
          },
          'completed',
          {
            taskToolItemIds: rt.taskToolItemIds || {},
            taskMetaById: rt.taskMetaById || {},
            rosterById: rt.rosterById || {},
          }
        );
      }

      // Output is reflected on the task card and DAG.
    }),
    CoworkAPI.onNeedsUserInput((p: CoworkEventLike) => {
      if (p?.coworkSessionId !== coworkSessionId) return;
      const qs = Array.isArray(p.questions) ? p.questions : [];
      setCoworkWaitingTask(flowChatSessionId, p.taskId || null);

      const rt = getCoworkRuntime(flowChatSessionId);
      if (rt?.taskMetaById && p.taskId) {
        const meta = rt.taskMetaById[p.taskId] || {
          title: p.taskId,
          description: p.taskId,
          assignee: 'unknown',
        };
        upsertCoworkTaskCard(
          context,
          flowChatSessionId,
          rt.rootDialogTurnId,
          ensureRootRound(),
          {
            id: p.taskId,
            title: meta.title,
            description: meta.description,
            assignee: meta.assignee,
            state: 'waiting_user_input',
          },
          'waiting_user_input',
          {
            taskToolItemIds: rt.taskToolItemIds || {},
            taskMetaById: rt.taskMetaById || {},
            rosterById: rt.rosterById || {},
          }
        );
      }

      upsertCoworkMainText(
        context,
        flowChatSessionId,
        rt.rootDialogTurnId,
        ensureRootRound(),
        buildCoworkMainText({
          goal: displayMessage,
          coworkSessionId,
          sessionState,
          waitingTaskId: p.taskId || null,
          questions: qs,
          rosterById: rt.rosterById || {},
        }),
        'pending'
      );
    }),
    CoworkAPI.onSessionState((p: CoworkEventLike) => {
      if (p?.coworkSessionId !== coworkSessionId) return;
      const st = String(p.state || '');
      const rt = getCoworkRuntime(flowChatSessionId);
      if (rt) {
        upsertCoworkMainText(
          context,
          flowChatSessionId,
          rt.rootDialogTurnId,
          ensureRootRound(),
          buildCoworkMainText({
            goal: displayMessage,
            coworkSessionId,
            sessionState: st,
            rosterById: rt.rosterById || {},
            phaseHint: st === 'running' ? 'Executing…' : undefined,
          }),
          'completed'
        );
      }
      if (st === 'completed') finalizeRoot(true);
      if (st === 'error') finalizeRoot(false, 'Cowork session ended in error');
      if (st === 'cancelled') finalizeRoot(false, 'Cowork cancelled');
    }),
  ];

  const rt = getCoworkRuntime(flowChatSessionId);
  if (rt) {
    rt.unsubscribers = unsubs;
    setCoworkRuntime(flowChatSessionId, rt);
  }

  // Trigger plan generation, then start scheduler.
  // No extra lines; main text is updated in-place.
  await CoworkAPI.generatePlan(coworkSessionId);
  await CoworkAPI.start(coworkSessionId);
}

function appendText(
  context: FlowChatContext,
  sessionId: string,
  dialogTurnId: string,
  modelRoundId: string,
  markdown: string,
  status: FlowTextItem['status'],
  metadata: Record<string, any> = {}
) {
  const item: FlowTextItem = {
    id: `cowork_text_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    type: 'text',
    content: markdown,
    isStreaming: false,
    isMarkdown: true,
    timestamp: Date.now(),
    status,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  context.flowChatStore.addModelRoundItem(sessionId, dialogTurnId, item, modelRoundId);
}

function handleTitleGeneration(
  context: FlowChatContext,
  sessionId: string,
  message: string
): void {
  const tempTitle = generateTempTitle(message, 20);
  context.flowChatStore.updateSessionTitle(sessionId, tempTitle, 'generating');
  
  if (aiExperienceConfigService.isSessionTitleGenerationEnabled()) {
    agentAPI.generateSessionTitle(sessionId, message, 20)
      .then((_aiTitle) => {
      })
      .catch((error) => {
        log.debug('AI title generation failed, keeping temp title', { sessionId, error });
        context.flowChatStore.updateSessionTitle(sessionId, tempTitle, 'generated');
      });
  } else {
    context.flowChatStore.updateSessionTitle(sessionId, tempTitle, 'generated');
  }
}

export async function cancelCurrentTask(context: FlowChatContext): Promise<boolean> {
  try {
    const state = context.flowChatStore.getState();
    const sessionId = state.activeSessionId;
    
    if (!sessionId) {
      log.debug('No active session to cancel');
      return false;
    }
    
    const currentState = stateMachineManager.getCurrentState(sessionId);
    const success = currentState === SessionExecutionState.PROCESSING 
      ? await stateMachineManager.transition(sessionId, SessionExecutionEvent.USER_CANCEL)
      : false;
    
    if (success) {
      markCurrentTurnItemsAsCancelled(context, sessionId);
      cleanupSessionBuffers(context, sessionId);
    }
    
    return success;
    
  } catch (error) {
    log.error('Failed to cancel current task', error);
    return false;
  }
}

export function markCurrentTurnItemsAsCancelled(
  context: FlowChatContext,
  sessionId: string
): void {
  const state = context.flowChatStore.getState();
  const session = state.sessions.get(sessionId);
  if (!session) return;
  
  const lastDialogTurn = session.dialogTurns[session.dialogTurns.length - 1];
  if (!lastDialogTurn) return;
  
  if (lastDialogTurn.status === 'completed' || lastDialogTurn.status === 'cancelled') {
    return;
  }
  
  lastDialogTurn.modelRounds.forEach(round => {
    round.items.forEach(item => {
      if (item.status === 'completed' || item.status === 'cancelled' || item.status === 'error') {
        return;
      }
      
      context.flowChatStore.updateModelRoundItem(sessionId, lastDialogTurn.id, item.id, {
        status: 'cancelled',
        ...(item.type === 'text' && { isStreaming: false }),
        ...(item.type === 'tool' && { 
          isParamsStreaming: false,
          endTime: Date.now()
        })
      } as any);
    });
  });
  
  context.flowChatStore.updateDialogTurn(sessionId, lastDialogTurn.id, turn => ({
    ...turn,
    status: 'cancelled',
    endTime: Date.now()
  }));
}
