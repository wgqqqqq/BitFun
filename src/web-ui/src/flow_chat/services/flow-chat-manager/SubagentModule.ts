/**
 * Routes subagent events to their parent tool cards.
 */

import { FlowChatStore } from '../../store/FlowChatStore';
import { createLogger } from '@/shared/utils/logger';
import type { FlowChatContext, FlowTextItem, SubagentTextChunkData, SubagentToolEventData } from './types';
import { THINKING_END_MARKER } from './types';
import { processToolEvent } from './ToolEventModule';

const log = createLogger('SubagentModule');

/**
 * Route subagent text chunks to the parent tool card.
 * Supports "text" and "thinking" content types.
 */
export function routeTextChunkToToolCard(
  _context: FlowChatContext,
  parentSessionId: string,
  parentToolId: string,
  data: SubagentTextChunkData
): void {
  const store = FlowChatStore.getInstance();
  const parentSession = store.getState().sessions.get(parentSessionId);
  
  if (!parentSession) {
    log.debug('Parent session not found (Subagent TextChunk)', { parentSessionId });
    return;
  }

  let parentTurnId: string | null = null;
  for (const turn of parentSession.dialogTurns) {
    const hasParentTool = turn.modelRounds.some(round => 
      round.items.some(item => item.id === parentToolId)
    );
    if (hasParentTool) {
      parentTurnId = turn.id;
      break;
    }
  }
  
  if (!parentTurnId) {
    log.debug('Parent tool DialogTurn not found', { parentSessionId, parentToolId });
    return;
  }
  
  const isThinking = data.contentType === 'thinking';
  const itemPrefix = isThinking ? 'subagent-thinking' : 'subagent-text';
  // Format: subagent-{type}-{parentToolId}-{sessionId}-{roundId}
  const itemId = `${itemPrefix}-${parentToolId}-${data.sessionId}-${data.roundId}`;
  
  const hasEndMarker = isThinking && data.text.includes(THINKING_END_MARKER);
  // Strip the end marker from the rendered content.
  const cleanText = data.text.replace(THINKING_END_MARKER, '');
  
  const parentTurn = parentSession.dialogTurns.find(turn => turn.id === parentTurnId);
  let existingItem: FlowTextItem | import('../../types/flow-chat').FlowThinkingItem | null = null;
  
  if (parentTurn) {
    for (const round of parentTurn.modelRounds) {
      const found = round.items.find(item => item.id === itemId);
      if (found) {
        existingItem = found as FlowTextItem | import('../../types/flow-chat').FlowThinkingItem;
        break;
      }
    }
  }
  
  if (existingItem) {
    if (hasEndMarker) {
      store.updateModelRoundItem(parentSessionId, parentTurnId, itemId, {
        content: existingItem.content + cleanText,
        isStreaming: false,
        isCollapsed: true,
        status: 'completed',
        timestamp: Date.now()
      } as any);
      
    } else {
      store.updateModelRoundItem(parentSessionId, parentTurnId, itemId, {
        content: existingItem.content + cleanText,
        timestamp: Date.now()
      } as any);
    }
  } else {
    // Keep subagent item timestamps right after the parent tool.
    const parentTool = store.findToolItem(parentSessionId, parentTurnId, parentToolId);
    const parentTimestamp = parentTool?.timestamp || Date.now();
    
    if (isThinking) {
      const newThinkingItem: import('../../types/flow-chat').FlowThinkingItem = {
        id: itemId,
        type: 'thinking',
        content: cleanText,
        timestamp: parentTimestamp + 1,
        isStreaming: !hasEndMarker,
        isCollapsed: hasEndMarker,
        status: hasEndMarker ? 'completed' : 'streaming',
        isSubagentItem: true,
        parentTaskToolId: parentToolId,
        subagentSessionId: data.sessionId
      } as any;
      
      store.insertModelRoundItemAfterTool(parentSessionId, parentTurnId, parentToolId, newThinkingItem);
    } else {
      const newTextItem: FlowTextItem = {
        id: itemId,
        type: 'text',
        content: cleanText,
        timestamp: parentTimestamp + 1,
        isStreaming: true,
        status: 'streaming',
        isMarkdown: true,
        isSubagentItem: true,
        parentTaskToolId: parentToolId,
        subagentSessionId: data.sessionId
      };
      
      store.insertModelRoundItemAfterTool(parentSessionId, parentTurnId, parentToolId, newTextItem);
    }
  }
}

/**
 * Route subagent tool events to the parent tool card.
 */
export function routeToolEventToToolCard(
  context: FlowChatContext,
  parentSessionId: string,
  parentToolId: string,
  data: SubagentToolEventData,
  onTodoWriteResult?: (sessionId: string, turnId: string, result: any) => void
): void {
  const store = FlowChatStore.getInstance();
  const parentSession = store.getState().sessions.get(parentSessionId);
  
  if (!parentSession) {
    log.debug('Parent session not found (Subagent ToolEvent)', { parentSessionId });
    return;
  }

  let parentTurnId: string | null = null;
  for (const turn of parentSession.dialogTurns) {
    const hasParentTool = turn.modelRounds.some(round => 
      round.items.some(item => item.id === parentToolId)
    );
    if (hasParentTool) {
      parentTurnId = turn.id;
      break;
    }
  }
  
  if (!parentTurnId) {
    log.debug('Parent tool DialogTurn not found', { parentSessionId, parentToolId });
    return;
  }
  
  const { toolEvent } = data;
  
  // Keep subagent item timestamps right after the parent tool.
  const parentTool = store.findToolItem(parentSessionId, parentTurnId, parentToolId);
  const parentTimestamp = parentTool?.timestamp || Date.now();
  
  processToolEvent(context, parentSessionId, parentTurnId, toolEvent, {
    isSubagent: true,
    parentToolId: parentToolId,
    subagentSessionId: data.sessionId,
    parentTimestamp: parentTimestamp
  }, onTodoWriteResult);
}

/**
 * Internal TextChunk routing for batch processing.
 */
export function routeTextChunkToToolCardInternal(
  context: FlowChatContext,
  parentSessionId: string,
  parentToolId: string,
  chunkData: {
    sessionId: string;
    turnId: string;
    roundId: string;
    text: string;
    contentType: string;
  }
): void {
  routeTextChunkToToolCard(context, parentSessionId, parentToolId, chunkData);
}

/**
 * Internal ToolEvent routing for batch processing.
 */
export function routeToolEventToToolCardInternal(
  context: FlowChatContext,
  parentSessionId: string,
  parentToolId: string,
  eventData: any,
  onTodoWriteResult?: (sessionId: string, turnId: string, result: any) => void
): void {
  routeToolEventToToolCard(context, parentSessionId, parentToolId, eventData, onTodoWriteResult);
}
