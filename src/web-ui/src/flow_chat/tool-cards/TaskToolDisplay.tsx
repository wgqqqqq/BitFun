/**
 * TaskTool card display component.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  ChevronDown,
  ChevronUp,
  Split,
  Timer,
  CheckCircle,
  PanelRightOpen
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CubeLoading, Button, IconButton, Textarea } from '../../component-library';
import type { ToolCardProps } from '../types/flow-chat';
import { BaseToolCard } from './BaseToolCard';
import { taskCollapseStateManager } from '../store/TaskCollapseStateManager';
import { CoworkAPI } from '@/infrastructure/api/service-api/CoworkAPI';
import { getCoworkRuntime, setCoworkRuntime } from '../services/coworkRuntime';
import './TaskToolDisplay.scss';

export const TaskToolDisplay: React.FC<ToolCardProps> = ({
  toolItem,
  onConfirm,
  onReject,
  onOpenInPanel,
  sessionId
}) => {
  const { t } = useTranslation('flow-chat');
  const { toolCall, toolResult, status, requiresConfirmation, userConfirmed } = toolItem;
  
  // Restore collapse state; default to collapsed until running.
  const [isExpanded, setIsExpanded] = useState(() => {
    const savedState = taskCollapseStateManager.getCollapsedOrUndefined(toolItem.id);
    if (savedState !== undefined) {
      return !savedState;
    }
    return status === 'pending_confirmation';
  });
  
  const isRunning = status === 'preparing' || status === 'streaming' || status === 'running';
  
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  const promptRef = useRef<HTMLDivElement>(null);
  const [isPromptOverflow, setIsPromptOverflow] = useState(false);
  
  const prevStatusRef = useRef(status);
  
  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    
    if (prevStatus !== status) {
      prevStatusRef.current = status;
      
      if (status === 'completed') {
        setIsExpanded(false);
      } else if (status === 'pending_confirmation') {
        setIsExpanded(true);
      } else if (isRunning) {
        setIsExpanded(true);
      }
    }
  }, [status, isRunning]);
  
  useEffect(() => {
    const prompt = toolCall?.input?.prompt;
    if (prompt) {
      let visualWidth = 0;
      for (const char of prompt) {
        visualWidth += isFullWidth(char) ? 2 : 1;
      }
      setIsPromptOverflow(visualWidth > 100 || prompt.includes('\n'));
    }
  }, [toolCall?.input?.prompt]);
  
  useEffect(() => {
    taskCollapseStateManager.setCollapsed(toolItem.id, !isExpanded);
  }, [isExpanded, toolItem.id]);

  // Detect full-width characters for visual width estimation.
  const isFullWidth = (char: string) => {
    const code = char.charCodeAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xAC00 && code <= 0xD7AF) ||
      (code >= 0x3040 && code <= 0x309F) ||
      (code >= 0x30A0 && code <= 0x30FF) ||
      (code >= 0xFF00 && code <= 0xFFEF)
    );
  };

  // Truncate by visual width (full-width counts as 2).
  const truncateByVisualWidth = (str: string, maxWidth: number) => {
    let width = 0;
    let result = '';
    
    for (const char of str) {
      const charWidth = isFullWidth(char) ? 2 : 1;
      
      if (width + charWidth > maxWidth) {
        return result + '...';
      }
      
      width += charWidth;
      result += char;
    }
    
    return result;
  };

  const getTaskInput = () => {
    if (!toolCall?.input) return null;
    
    const isEarlyDetection = toolCall.input._early_detection === true;
    const isPartialParams = toolCall.input._partial_params === true;
    
    if (isEarlyDetection || isPartialParams) {
      return null;
    }
    
    const inputKeys = Object.keys(toolCall.input).filter(key => !key.startsWith('_'));
    if (inputKeys.length === 0) return null;
    
    const { description, prompt, subagent_type } = toolCall.input;
    return {
      description: description || (prompt ? truncateByVisualWidth(prompt, 70) : 'Not provided'),
      prompt: prompt || 'Not provided',
      agentType: subagent_type || 'Not provided'
    };
  };

  const taskInput = getTaskInput();

  const isFailed = status === 'error';
  const coworkTaskId = (toolItem.metadata as any)?.coworkTaskId as string | undefined;
  const coworkQuestions = (toolItem.metadata as any)?.coworkQuestions as string[] | undefined;
  const coworkRuntime = sessionId ? getCoworkRuntime(sessionId) : undefined;
  const isCoworkTask = Boolean(coworkTaskId && toolItem.metadata?.source === 'cowork-main');
  const toolResultOutputText = (toolResult as any)?.result?.output as string | undefined;
  const toolResultErrorText = (toolResult as any)?.result?.error as string | undefined;
  const effectiveQuestions =
    Array.isArray(coworkQuestions) && coworkQuestions.length > 0
      ? coworkQuestions
      : (coworkRuntime?.waitingTaskId && coworkRuntime.waitingTaskId === coworkTaskId
        ? coworkRuntime.waitingQuestions
        : undefined);

  const [coworkAnswerText, setCoworkAnswerText] = useState('');
  const [isSubmittingCoworkAnswers, setIsSubmittingCoworkAnswers] = useState(false);

  const handleCardClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.preview-toggle-btn') || target.closest('.tool-actions') || target.closest('.result-expand-toggle')) {
      return;
    }
    
    if (isFailed) {
      return;
    }
    
    // Pause auto-scroll while the user toggles the card.
    window.dispatchEvent(new CustomEvent('tool-card-toggle'));
    setIsExpanded(!isExpanded);
  }, [isFailed, isExpanded]);

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    const seconds = (ms / 1000).toFixed(1);
    return `${seconds}s`;
  };

  const renderToolIcon = () => {
    return <Split size={18} />;
  };

  const renderStatusIcon = () => {
    if (isRunning) {
      return <CubeLoading size="small" />;
    }
    if (status === 'completed' && !isFailed) {
      return <CheckCircle className="icon-completed" size={14} />;
    }
    return null;
  };

  const renderHeader = () => {
    const hasPromptContent = taskInput && taskInput.prompt && taskInput.prompt !== 'Not provided';
    const isPromptVisible = hasPromptContent && (!isPromptOverflow || isPromptExpanded);
    
    return (
    <div className="task-header-wrapper">
      <div className={`task-icon-container ${isRunning ? 'is-running' : ''} ${isPromptVisible ? 'prompt-visible' : ''}`}>
        {renderToolIcon()}
      </div>
      
      <div className="task-content-wrapper">
        <div className={`task-header-main ${isFailed ? 'task-header-main--failed' : ''}`}>
          <span className="task-action">
            {taskInput?.description || ''}
          </span>
          {taskInput?.agentType && (
            <span className="agent-type-badge">{taskInput.agentType}</span>
          )}
          <div className="task-header-extra">
            {status === 'completed' && toolResult?.result?.duration && (
              <span className="duration-text">
                <Timer size={11} />
                {formatDuration(toolResult.result.duration)}
              </span>
            )}
            {isFailed && (
              <span className="task-failed-badge">{t('toolCards.taskTool.failed')}</span>
            )}
            
            <IconButton
              className="preview-toggle-btn"
              variant="ghost"
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent('tool-card-toggle'));
                setIsExpanded(!isExpanded);
              }}
              tooltip={isExpanded ? t('toolCards.common.collapse') : t('toolCards.common.expand')}
              tooltipPlacement="top"
            >
              {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </IconButton>
            
            <IconButton
              className="open-panel-btn"
              variant="ghost"
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                const panelData = { toolItem, taskInput, sessionId };
                const tabInfo = {
                  type: 'task-detail',
                  title: taskInput?.description || 'Sub Agent Task',
                  data: panelData,
                  metadata: { taskId: toolItem.id }
                };
                if (onOpenInPanel) {
                  onOpenInPanel(tabInfo.type, tabInfo);
                } else {
                  window.dispatchEvent(new CustomEvent('agent-create-tab', { detail: tabInfo }));
                }
              }}
              tooltip={t('toolCards.taskTool.openInPanel')}
              tooltipPlacement="top"
            >
              <PanelRightOpen size={12} />
            </IconButton>
            
            <div className="task-status-icon">
              {renderStatusIcon()}
            </div>
          </div>
        </div>
        {renderPromptRow()}
      </div>
    </div>
  )};

  const handlePromptRowClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (isPromptOverflow) {
      window.dispatchEvent(new CustomEvent('tool-card-toggle'));
      setIsPromptExpanded(!isPromptExpanded);
    }
  }, [isPromptExpanded, isPromptOverflow]);

  const renderPromptRow = () => {
    const hasPrompt = taskInput && taskInput.prompt && taskInput.prompt !== 'Not provided';
    
    if (!hasPrompt) {
      return null;
    }
    
    const isPromptCollapsed = !isPromptExpanded && isPromptOverflow;
    
    return (
      <div 
        className={`task-prompt-row ${isPromptCollapsed ? 'task-prompt-row--collapsed' : ''} ${isPromptOverflow ? 'task-prompt-row--clickable' : ''}`}
        onClick={handlePromptRowClick}
      >
        <div 
          ref={promptRef}
          className="task-prompt-content"
        >
          {taskInput!.prompt}
        </div>
        {isPromptExpanded && isPromptOverflow && (
          <IconButton 
            className="task-prompt-toggle-btn task-prompt-toggle-btn--collapse" 
            variant="ghost"
            size="xs"
            onClick={handlePromptRowClick} 
            tooltip={t('toolCards.common.collapse')}
          >
            <ChevronUp size={14} />
          </IconButton>
        )}
      </div>
    );
  };

  const renderExpandedContent = () => {
    const needsConfirmation = requiresConfirmation && !userConfirmed && status !== 'completed' && !isCoworkTask;

    const hasCoworkQuestions = status === 'pending_confirmation' && isCoworkTask && Array.isArray(effectiveQuestions) && effectiveQuestions.length > 0;

    const hasResult = Boolean(toolResultOutputText || toolResultErrorText || (toolResult && (toolResult as any).result));

    const submitCoworkAnswers = async () => {
      if (!sessionId) return;
      const rt = getCoworkRuntime(sessionId);
      if (!rt?.coworkSessionId || !coworkTaskId) return;

      const answers = coworkAnswerText
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

      if (answers.length === 0) return;

      setIsSubmittingCoworkAnswers(true);
      try {
        await CoworkAPI.submitUserInput(rt.coworkSessionId, coworkTaskId, answers);
        // Prevent the next chat message from being misinterpreted as answers.
        if (rt.waitingTaskId === coworkTaskId) {
          setCoworkRuntime(sessionId, { ...rt, waitingTaskId: null, waitingQuestions: [] });
        }
        setCoworkAnswerText('');
      } finally {
        setIsSubmittingCoworkAnswers(false);
      }
    };

    return (
      <div className="task-expanded-content">
        {hasCoworkQuestions && (
          <div className="cowork-hitl">
            <div className="cowork-hitl__title">Needs your input</div>
            <ul className="cowork-hitl__questions">
              {effectiveQuestions!.map((q, idx) => (
                <li key={`${idx}-${q}`}>{q}</li>
              ))}
            </ul>
            <div className="cowork-hitl__hint">Answer one per line, then submit.</div>
            <Textarea
              className="cowork-hitl__textarea"
              value={coworkAnswerText}
              onChange={e => setCoworkAnswerText(e.target.value)}
              placeholder="Type answers here…"
              autoResize={true}
              rows={3}
              disabled={isSubmittingCoworkAnswers}
            />
            <div className="cowork-hitl__actions">
              <Button
                variant="primary"
                size="small"
                onClick={submitCoworkAnswers}
                disabled={isSubmittingCoworkAnswers || coworkAnswerText.trim().length === 0}
              >
                {isSubmittingCoworkAnswers ? 'Submitting…' : 'Submit answers'}
              </Button>
            </div>
          </div>
        )}

        {needsConfirmation && (
          <div className="tool-actions">
            <Button 
              className="confirm-button"
              variant="primary"
              size="small"
              onClick={() => onConfirm?.(toolCall?.input)}
              disabled={status === 'streaming'}
            >
              {t('toolCards.taskTool.confirmDelegate')}
            </Button>
            <Button 
              className="reject-button"
              variant="ghost"
              size="small"
              onClick={() => onReject?.()}
              disabled={status === 'streaming'}
            >
              {t('toolCards.taskTool.cancel')}
            </Button>
          </div>
        )}

        {!isFailed && hasResult && (
          <div className="task-result">
            <div className="task-result__label">Result</div>
            <pre className="task-result__pre">
              {toolResultOutputText
                ? toolResultOutputText
                : toolResultErrorText
                  ? toolResultErrorText
                  : JSON.stringify((toolResult as any)?.result ?? toolResult, null, 2)}
            </pre>
          </div>
        )}

        {!hasCoworkQuestions && !needsConfirmation && !hasResult && (
          <div className="task-expanded-empty">No additional details yet.</div>
        )}
      </div>
    );
  };

  // Error details are shown in the side panel only.
  const hasPrompt = taskInput && taskInput.prompt && taskInput.prompt !== 'Not provided';
  const isPromptRowExpanded = hasPrompt && isPromptExpanded;
  
  const cardClassName = [
    'task-tool-display',
    isPromptRowExpanded ? 'prompt-expanded' : ''
  ].filter(Boolean).join(' ');

  return (
    <BaseToolCard
      status={status}
      isExpanded={isExpanded}
      onClick={handleCardClick}
      className={cardClassName}
      header={renderHeader()}
      expandedContent={renderExpandedContent()}
      isFailed={isFailed}
      requiresConfirmation={requiresConfirmation && !userConfirmed}
      errorContent={
        isFailed ? (
          <div className="task-error">
            <div className="task-error__label">Error</div>
            <pre className="task-error__pre">
              {toolResultErrorText || (toolResult as any)?.error || (toolResult as any)?.result?.error || 'Task failed.'}
            </pre>
          </div>
        ) : undefined
      }
    />
  );
};
