/**
 * Handles streamed text chunks and thinking content.
 */

import { FlowChatStore } from '../../store/FlowChatStore';
import { parsePartialJson } from '../../../shared/utils/partialJsonParser';
import type { FlowChatContext, FlowTextItem } from './types';
import { THINKING_END_MARKER } from './types';
/**
 * Process a normal text chunk without notifying the store.
 */
export function processNormalTextChunkInternal(
  context: FlowChatContext,
  sessionId: string,
  turnId: string,
  roundId: string,
  text: string
): void {
  if (!context.contentBuffers.has(sessionId)) {
    context.contentBuffers.set(sessionId, new Map());
  }
  if (!context.activeTextItems.has(sessionId)) {
    context.activeTextItems.set(sessionId, new Map());
  }
  
  const sessionContentBuffer = context.contentBuffers.get(sessionId)!;
  const sessionActiveTextItems = context.activeTextItems.get(sessionId)!;

  // Coalesce excessive newlines while appending.
  const currentContent = sessionContentBuffer.get(roundId) || '';
  const cleanedContent = (currentContent + text).replace(/\n{3,}/g, '\n\n');
  sessionContentBuffer.set(roundId, cleanedContent);

  let textItemId = sessionActiveTextItems.get(roundId);
  
  if (!textItemId) {
    textItemId = `text_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const textItem: FlowTextItem = {
      id: textItemId,
      type: 'text',
      content: cleanedContent,
      isStreaming: true,
      isMarkdown: true,
      timestamp: Date.now(),
      status: 'streaming'
    };
    
    context.flowChatStore.addModelRoundItemSilent(sessionId, turnId, textItem, roundId);
    sessionActiveTextItems.set(roundId, textItemId);
  } else {
    context.flowChatStore.updateModelRoundItemSilent(sessionId, turnId, textItemId, {
      content: cleanedContent,
      timestamp: Date.now()
    } as any);
  }
}

/**
 * Process thinking chunks without notifying the store.
 * Uses the <thinking_end> marker to avoid ordering issues.
 */
export function processThinkingChunkInternal(
  context: FlowChatContext,
  sessionId: string,
  turnId: string,
  roundId: string,
  text: string
): void {
  if (!context.contentBuffers.has(sessionId)) {
    context.contentBuffers.set(sessionId, new Map());
  }
  if (!context.activeTextItems.has(sessionId)) {
    context.activeTextItems.set(sessionId, new Map());
  }
  
  const sessionContentBuffer = context.contentBuffers.get(sessionId)!;
  const sessionActiveTextItems = context.activeTextItems.get(sessionId)!;

  // Store thinking content under a separate key.
  const thinkingKey = `thinking_${roundId}`;
  
  const hasEndMarker = text.includes(THINKING_END_MARKER);
  // Strip the end marker from stored content.
  const cleanText = text.replace(THINKING_END_MARKER, '');
  
  const currentContent = sessionContentBuffer.get(thinkingKey) || '';
  const cleanedContent = (currentContent + cleanText).replace(/\n{3,}/g, '\n\n');
  sessionContentBuffer.set(thinkingKey, cleanedContent);

  let thinkingItemId = sessionActiveTextItems.get(thinkingKey);
  
  if (!thinkingItemId) {
    thinkingItemId = `thinking_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const thinkingItem: import('../../types/flow-chat').FlowThinkingItem = {
      id: thinkingItemId,
      type: 'thinking',
      content: cleanedContent,
      isStreaming: !hasEndMarker,
      isCollapsed: hasEndMarker,
      timestamp: Date.now(),
      status: hasEndMarker ? 'completed' : 'streaming'
    };
    
    context.flowChatStore.addModelRoundItemSilent(sessionId, turnId, thinkingItem, roundId);
    sessionActiveTextItems.set(thinkingKey, thinkingItemId);
    
    // Clear buffers once the end marker arrives.
    if (hasEndMarker) {
      sessionContentBuffer.delete(thinkingKey);
      sessionActiveTextItems.delete(thinkingKey);
    }
  } else {
    if (hasEndMarker) {
      context.flowChatStore.updateModelRoundItemSilent(sessionId, turnId, thinkingItemId, {
        content: cleanedContent,
        isStreaming: false,
        isCollapsed: true,
        status: 'completed',
        timestamp: Date.now()
      } as any);
      
      sessionContentBuffer.delete(thinkingKey);
      sessionActiveTextItems.delete(thinkingKey);
    } else {
      context.flowChatStore.updateModelRoundItemSilent(sessionId, turnId, thinkingItemId, {
        content: cleanedContent,
        timestamp: Date.now()
      } as any);
    }
  }
}

/**
 * Merge partial tool params without notifying the store.
 */
export function processToolParamsPartialInternal(
  _context: FlowChatContext,
  sessionId: string,
  turnId: string,
  toolEvent: any
): void {
  const store = FlowChatStore.getInstance();
  const existingItem = store.findToolItem(sessionId, turnId, toolEvent.tool_id);
  
  if (existingItem) {
    const currentParams = (existingItem as any).parameters || {};
    let newParams = currentParams;
    
    if (toolEvent.params_partial) {
      try {
        const partialParams = parsePartialJson(toolEvent.params_partial);
        newParams = { ...currentParams, ...partialParams };
      } catch {
        // Ignore parse errors to keep streaming resilient.
      }
    }
    
    store.updateModelRoundItemSilent(sessionId, turnId, toolEvent.tool_id, {
      parameters: newParams,
      _rawParamsPartial: ((existingItem as any)._rawParamsPartial || '') + (toolEvent.params_partial || '')
    } as any);
  }
}

/**
 * Update tool progress without notifying the store.
 */
export function processToolProgressInternal(
  _context: FlowChatContext,
  sessionId: string,
  turnId: string,
  toolEvent: any
): void {
  const store = FlowChatStore.getInstance();
  const existingItem = store.findToolItem(sessionId, turnId, toolEvent.tool_id);
  
  if (existingItem) {
    store.updateModelRoundItemSilent(sessionId, turnId, toolEvent.tool_id, {
      _progressMessage: toolEvent.message,
      _progressPercentage: toolEvent.percentage
    } as any);
  }
}

/**
 * Finalize streaming state for active text items.
 */
export function completeActiveTextItems(
  context: FlowChatContext,
  sessionId: string,
  turnId: string
): void {
  const sessionActiveTextItems = context.activeTextItems.get(sessionId);
  if (sessionActiveTextItems && sessionActiveTextItems.size > 0) {
    const itemsToComplete = Array.from(sessionActiveTextItems.entries());
    const batchUpdates = itemsToComplete
      .map(([_roundId, itemId]) => ({
        itemId,
        changes: {
          isStreaming: false,
          status: 'completed' as const
        }
      }));
    
    if (batchUpdates.length > 0) {
      context.flowChatStore.batchUpdateModelRoundItems(sessionId, turnId, batchUpdates);
    }
    
    sessionActiveTextItems.clear();
  }
}

/**
 * Clean up session buffers.
 */
export function cleanupSessionBuffers(context: FlowChatContext, sessionId: string): void {
  const batcherSize = context.eventBatcher.getBufferSize();
  if (batcherSize > 0) {
    context.eventBatcher.clear();
  }
  
  const contentBuffer = context.contentBuffers.get(sessionId);
  if (contentBuffer) {
    context.contentBuffers.delete(sessionId);
  }
  
  const activeItems = context.activeTextItems.get(sessionId);
  if (activeItems) {
    context.activeTextItems.delete(sessionId);
  }
}

/**
 * Clear all buffers and transient state.
 */
export function clearAllBuffers(context: FlowChatContext): void {
  context.contentBuffers.clear();
  context.activeTextItems.clear();
  
  for (const timer of context.saveDebouncers.values()) {
    clearTimeout(timer);
  }
  context.saveDebouncers.clear();
  context.lastSaveTimestamps.clear();
  context.lastSaveHashes.clear();
  context.turnSavePending.clear();
  context.turnSaveInFlight.clear();
}
