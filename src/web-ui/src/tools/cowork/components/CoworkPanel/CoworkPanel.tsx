/**
 * Cowork side panel (MVP).
 * Provides: create session, generate/edit plan, start/pause/cancel, timeline.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Textarea, IconButton } from '@/component-library';
import { PanelHeader } from '@/app/components/panels/base';
import { createLogger } from '@/shared/utils/logger';
import { CoworkAPI } from '@/infrastructure/api/service-api/CoworkAPI';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { useCoworkStore } from '../../store/coworkStore';
import type { CoworkTask } from '../../types';
import { Play, Pause, XCircle, RefreshCw, Save } from 'lucide-react';
import './CoworkPanel.scss';

const log = createLogger('CoworkPanel');

const CoworkPanel: React.FC<{ isActive?: boolean; className?: string }> = ({ isActive = false, className = '' }) => {
  const { openWorkspace } = useWorkspaceContext();
  const {
    coworkSessionId,
    goalInput,
    sessionState,
    roster,
    tasks,
    taskOrder,
    timeline,
    error,
    setGoalInput,
    setError,
    applySessionCreated,
    applyPlan,
    applySessionState,
    applyTaskStateChanged,
    applyTaskOutput,
    applyNeedsUserInput,
    addTimelineEvent,
  } = useCoworkStore();

  const [isBusy, setIsBusy] = useState(false);

  const orderedTasks = useMemo(() => {
    if (!taskOrder?.length) return tasks;
    const map = new Map(tasks.map(t => [t.id, t]));
    return taskOrder.map(id => map.get(id)).filter(Boolean) as CoworkTask[];
  }, [tasks, taskOrder]);

  useEffect(() => {
    const unsubs = [
      CoworkAPI.onSessionCreated((payload) => applySessionCreated(payload)),
      CoworkAPI.onPlanGenerated((payload) => applyPlan({ ...payload, eventName: 'cowork://plan-generated' })),
      CoworkAPI.onPlanUpdated((payload) => applyPlan({ ...payload, eventName: 'cowork://plan-updated' })),
      CoworkAPI.onSessionState((payload) => applySessionState(payload)),
      CoworkAPI.onTaskStateChanged((payload) => applyTaskStateChanged(payload)),
      CoworkAPI.onTaskOutput((payload) => applyTaskOutput(payload)),
      CoworkAPI.onNeedsUserInput((payload) => applyNeedsUserInput(payload)),
    ];
    return () => {
      unsubs.forEach(u => u());
    };
  }, [applySessionCreated, applyPlan, applySessionState, applyTaskStateChanged, applyTaskOutput, applyNeedsUserInput]);

  const handleCreate = useCallback(async () => {
    if (!goalInput.trim()) return;
    setIsBusy(true);
    setError(null);
    try {
      const resp = await CoworkAPI.createSession({ goal: goalInput.trim(), roster });
      if (resp.workspaceRoot) {
        await openWorkspace(resp.workspaceRoot, {
          addToRecent: false,
          persist: false,
          metadata: {
            source: 'cowork',
            temporary: true,
            coworkSessionId: resp.coworkSessionId,
          },
        });
      }
      applySessionCreated({ coworkSessionId: resp.coworkSessionId, goal: goalInput.trim(), roster });
    } catch (e) {
      log.error('Failed to create cowork session', { error: e });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(false);
    }
  }, [goalInput, roster, applySessionCreated, setError, openWorkspace]);

  const handleGeneratePlan = useCallback(async () => {
    if (!coworkSessionId) return;
    setIsBusy(true);
    setError(null);
    try {
      const tasks = await CoworkAPI.generatePlan(coworkSessionId);
      applyPlan({ coworkSessionId, tasks, taskOrder: tasks.map(t => t.id), eventName: 'cowork://plan-generated' });
    } catch (e) {
      log.error('Failed to generate plan', { error: e });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(false);
    }
  }, [coworkSessionId, applyPlan, setError]);

  const handleSavePlan = useCallback(async () => {
    if (!coworkSessionId) return;
    setIsBusy(true);
    setError(null);
    try {
      await CoworkAPI.updatePlan(coworkSessionId, tasks, taskOrder);
      addTimelineEvent('ui://plan-saved', { coworkSessionId });
    } catch (e) {
      log.error('Failed to update plan', { error: e });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(false);
    }
  }, [coworkSessionId, tasks, taskOrder, addTimelineEvent, setError]);

  const handleStart = useCallback(async () => {
    if (!coworkSessionId) return;
    setIsBusy(true);
    setError(null);
    try {
      await CoworkAPI.start(coworkSessionId);
    } catch (e) {
      log.error('Failed to start cowork', { error: e });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(false);
    }
  }, [coworkSessionId, setError]);

  const handlePause = useCallback(async () => {
    if (!coworkSessionId) return;
    setIsBusy(true);
    setError(null);
    try {
      await CoworkAPI.pause(coworkSessionId);
    } catch (e) {
      log.error('Failed to pause cowork', { error: e });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(false);
    }
  }, [coworkSessionId, setError]);

  const handleCancel = useCallback(async () => {
    if (!coworkSessionId) return;
    setIsBusy(true);
    setError(null);
    try {
      await CoworkAPI.cancel(coworkSessionId);
    } catch (e) {
      log.error('Failed to cancel cowork', { error: e });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(false);
    }
  }, [coworkSessionId, setError]);

  const updateTask = useCallback((taskId: string, patch: Partial<CoworkTask>) => {
    useCoworkStore.setState((prev) => ({
      tasks: prev.tasks.map(t => (t.id === taskId ? { ...t, ...patch } : t)),
    }) as any);
  }, []);

  return (
    <div className={`bitfun-cowork-panel ${isActive ? 'bitfun-cowork-panel--active' : ''} ${className}`}>
      <PanelHeader
        title="Cowork"
        actions={
          <>
            <IconButton size="xs" onClick={handleGeneratePlan} disabled={!coworkSessionId || isBusy} tooltip="Generate plan">
              <RefreshCw size={14} />
            </IconButton>
            <IconButton size="xs" onClick={handleSavePlan} disabled={!coworkSessionId || isBusy || tasks.length === 0} tooltip="Save plan">
              <Save size={14} />
            </IconButton>
            <IconButton size="xs" onClick={handleStart} disabled={!coworkSessionId || isBusy || tasks.length === 0} tooltip="Start">
              <Play size={14} />
            </IconButton>
            <IconButton size="xs" onClick={handlePause} disabled={!coworkSessionId || isBusy} tooltip="Pause">
              <Pause size={14} />
            </IconButton>
            <IconButton size="xs" onClick={handleCancel} disabled={!coworkSessionId || isBusy} tooltip="Cancel">
              <XCircle size={14} />
            </IconButton>
          </>
        }
      />

      <div className="bitfun-cowork-panel__content">
        <div className="bitfun-cowork-panel__section">
          <div className="bitfun-cowork-panel__meta">
            <div><strong>Session</strong>: {coworkSessionId ?? '—'}</div>
            <div><strong>State</strong>: {sessionState ?? '—'}</div>
          </div>

          <Textarea
            className="bitfun-cowork-panel__goal"
            placeholder="Describe your goal / daily work request..."
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
            disabled={isBusy}
          />
          <div className="bitfun-cowork-panel__actions">
            <Button size="small" variant="primary" onClick={handleCreate} disabled={isBusy || !goalInput.trim()}>
              Create session
            </Button>
            <Button size="small" variant="secondary" onClick={handleGeneratePlan} disabled={isBusy || !coworkSessionId}>
              Generate plan
            </Button>
          </div>

          {error && <div className="bitfun-cowork-panel__error">{error}</div>}
        </div>

        <div className="bitfun-cowork-panel__section">
          <div className="bitfun-cowork-panel__section-title">Tasks</div>
          {orderedTasks.length === 0 ? (
            <div className="bitfun-cowork-panel__empty">No tasks yet. Generate a plan first.</div>
          ) : (
            <div className="bitfun-cowork-panel__tasks">
              {orderedTasks.map((t) => (
                <div key={t.id} className="bitfun-cowork-panel__task">
                  <div className="bitfun-cowork-panel__task-header">
                    <div className="bitfun-cowork-panel__task-title">
                      <span className={`bitfun-cowork-panel__pill bitfun-cowork-panel__pill--${t.state}`}>{t.state}</span>
                      <strong>{t.title}</strong>
                    </div>
                    <div className="bitfun-cowork-panel__task-assignee">
                      <label>Assignee</label>
                      <select
                        value={t.assignee}
                        onChange={(e) => updateTask(t.id, { assignee: e.target.value })}
                        disabled={isBusy}
                      >
                        {roster.map(r => (
                          <option key={r.id} value={r.id}>{r.role} ({r.agentType || r.subagentType})</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <Textarea
                    value={t.description}
                    onChange={(e) => updateTask(t.id, { description: e.target.value })}
                    disabled={isBusy}
                  />

                  {t.deps?.length > 0 && (
                    <div className="bitfun-cowork-panel__deps">
                      <strong>Deps</strong>: {t.deps.join(', ')}
                    </div>
                  )}

                  {t.questions?.length > 0 && (
                    <div className="bitfun-cowork-panel__hitl">
                      <div><strong>Questions</strong>:</div>
                      <ul>
                        {t.questions.map((q, i) => <li key={i}>{q}</li>)}
                      </ul>
                      <Textarea
                        placeholder="Answer (one per line)..."
                        value={(t.userAnswers ?? []).join('\n')}
                        onChange={(e) => updateTask(t.id, { userAnswers: e.target.value.split('\n').filter(Boolean) })}
                        disabled={isBusy}
                      />
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={!coworkSessionId || isBusy}
                        onClick={async () => {
                          if (!coworkSessionId) return;
                          setIsBusy(true);
                          try {
                            await CoworkAPI.submitUserInput(coworkSessionId, t.id, t.userAnswers ?? []);
                          } catch (e) {
                            setError(e instanceof Error ? e.message : String(e));
                          } finally {
                            setIsBusy(false);
                          }
                        }}
                      >
                        Submit answers
                      </Button>
                    </div>
                  )}

                  {t.outputText && (
                    <div className="bitfun-cowork-panel__output">
                      <div><strong>Output</strong>:</div>
                      <pre>{t.outputText}</pre>
                    </div>
                  )}

                  {t.error && (
                    <div className="bitfun-cowork-panel__task-error">
                      <strong>Error</strong>: {t.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bitfun-cowork-panel__section">
          <div className="bitfun-cowork-panel__section-title">Timeline</div>
          <div className="bitfun-cowork-panel__timeline">
            {timeline.slice(0, 50).map(ev => (
              <div key={ev.id} className="bitfun-cowork-panel__timeline-item">
                <div className="bitfun-cowork-panel__timeline-type">{ev.type}</div>
                <div className="bitfun-cowork-panel__timeline-time">{new Date(ev.timestamp).toLocaleTimeString()}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CoworkPanel;
