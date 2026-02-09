/**
 * Streaming text block component.
 * Renders content directly without a typewriter delay.
 * Supports a streaming cursor indicator.
 */

import React, { useState, useEffect, useRef } from 'react';
import { MarkdownRenderer } from '@/component-library';
import type { FlowTextItem } from '../types/flow-chat';
import { useFlowChatContext } from './modern/FlowChatContext';
import { CoworkSummaryCard, type CoworkSummaryCardSummary } from './CoworkSummaryCard';
import './FlowTextBlock.scss';

// Idle timeout (ms) after content stops growing.
const CONTENT_IDLE_TIMEOUT = 500;

interface FlowTextBlockProps {
  textItem: FlowTextItem;
  className?: string;
}

/**
 * Use React.memo to avoid unnecessary re-renders.
 * Re-render only when key textItem fields change.
 */
export const FlowTextBlock = React.memo<FlowTextBlockProps>(({
  textItem,
  className = ''
}) => {
  const { onFileViewRequest, onTabOpen, onOpenVisualization } = useFlowChatContext();

  // Normalize content to a string.
  const content = typeof textItem.content === 'string'
    ? textItem.content
    : String(textItem.content || '');
  
  // Heuristic: if content does not change for a while, streaming is done.
  const [isContentGrowing, setIsContentGrowing] = useState(true);
  const lastContentRef = useRef(content);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  useEffect(() => {
    // Reset idle timer on content changes.
    if (content !== lastContentRef.current) {
      lastContentRef.current = content;
      setIsContentGrowing(true);
      
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      
      timeoutRef.current = setTimeout(() => {
        setIsContentGrowing(false);
      }, CONTENT_IDLE_TIMEOUT);
    }
    
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [content]);
  
  // Stop immediately when the item completes.
  useEffect(() => {
    if (textItem.status === 'completed' || !textItem.isStreaming) {
      setIsContentGrowing(false);
    }
  }, [textItem.status, textItem.isStreaming]);
  
  // Show shimmer only while content is actively growing.
  const isActivelyStreaming = textItem.isStreaming && 
    (textItem.status === 'streaming' || textItem.status === 'running') &&
    isContentGrowing;
  const hasContent = content.length > 0;
  const coworkSummary = (textItem.metadata as any)?.coworkSummary as CoworkSummaryCardSummary | undefined;
  const isCoworkMain = (textItem.metadata as any)?.source === 'cowork-main';

  return (
    <div className={`flow-text-block ${className} ${isActivelyStreaming ? 'streaming' : ''}`}>
      {isCoworkMain && coworkSummary ? (
        <CoworkSummaryCard summary={coworkSummary} />
      ) : textItem.isMarkdown ? (
        <MarkdownRenderer
          content={content}
          isStreaming={isActivelyStreaming}
          onFileViewRequest={onFileViewRequest}
          onTabOpen={onTabOpen}
          onOpenVisualization={onOpenVisualization}
        />
      ) : (
        <div className={`text-content ${isActivelyStreaming && hasContent ? 'text-content--streaming' : ''}`}>
          {content}
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  const coworkSummaryHash = (metadata: any): string => {
    const s = metadata?.coworkSummary;
    if (!s) return '';
    const running = Array.isArray(s.runningTitles) ? s.runningTitles.slice(0, 2).join('|') : '';
    const queued = Array.isArray(s.queuedTitles) ? s.queuedTitles.slice(0, 2).join('|') : '';
    const failed = Array.isArray(s.failedTitles) ? s.failedTitles.slice(0, 2).join('|') : '';
    return [
      s.coworkSessionId || '',
      s.sessionState || '',
      s.phaseHint || '',
      `${s.completed ?? ''}/${s.total ?? ''}`,
      s.waitingTaskId || '',
      running,
      queued,
      failed,
    ].join('::');
  };

  // Custom comparator: compare only key fields.
  const prev = prevProps.textItem;
  const next = nextProps.textItem;
  return (
    prev.id === next.id &&
    prev.content === next.content &&
    prev.isStreaming === next.isStreaming &&
    prev.status === next.status &&
    prevProps.className === nextProps.className &&
    coworkSummaryHash(prev.metadata) === coworkSummaryHash(next.metadata)
  );
});
