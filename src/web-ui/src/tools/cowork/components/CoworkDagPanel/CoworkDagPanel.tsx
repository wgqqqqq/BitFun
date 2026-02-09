import React, { useEffect, useMemo, useState } from 'react';
import ELK from 'elkjs/lib/elk.bundled.js';
import { Button } from '@/component-library';
import { createLogger } from '@/shared/utils/logger';
import { CoworkAPI } from '@/infrastructure/api/service-api/CoworkAPI';

import './CoworkDagPanel.scss';

const log = createLogger('CoworkDagPanel');

type CoworkTaskState =
  | 'draft'
  | 'ready'
  | 'blocked'
  | 'running'
  | 'waiting_user_input'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface CoworkRosterMemberLike {
  id: string;
  role?: string;
  subagentType?: string;
  agentType?: string;
}

interface CoworkTaskLike {
  id: string;
  title: string;
  description: string;
  deps: string[];
  assignee: string;
  state: CoworkTaskState;
  outputText?: string;
  error?: string | null;
}

interface CoworkDagPanelData {
  coworkSessionId: string;
  autoListen?: boolean;
}

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutEdgeSection {
  startPoint?: { x: number; y: number };
  endPoint?: { x: number; y: number };
  bendPoints?: Array<{ x: number; y: number }>;
}

interface LayoutEdge {
  id: string;
  sections: LayoutEdgeSection[];
}

const elk = new ELK();

function computeAssigneeLabel(assigneeId: string, rosterById: Record<string, CoworkRosterMemberLike>): string {
  const member = rosterById[assigneeId];
  if (!member) return assigneeId;
  const role = member.role || member.id || assigneeId;
  const tag = member.agentType || member.subagentType;
  return tag ? `${role} (${tag})` : role;
}

function stateClass(state: CoworkTaskState): string {
  return `cowork-dag-node--${state}`;
}

export const CoworkDagPanel: React.FC<{ data: CoworkDagPanelData }> = ({ data }) => {
  const coworkSessionId = data?.coworkSessionId;
  const autoListen = data?.autoListen !== false;

  const [roster, setRoster] = useState<CoworkRosterMemberLike[]>([]);
  const [tasks, setTasks] = useState<CoworkTaskLike[]>([]);
  const [taskOrder, setTaskOrder] = useState<string[]>([]);
  const [sessionState, setSessionState] = useState<string>('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [layout, setLayout] = useState<{ nodes: Record<string, LayoutNode>; edges: LayoutEdge[]; width: number; height: number } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rosterById = useMemo(() => {
    const byId: Record<string, CoworkRosterMemberLike> = {};
    for (const m of roster) {
      if (!m?.id) continue;
      byId[m.id] = m;
    }
    return byId;
  }, [roster]);

  const orderedTasks = useMemo(() => {
    if (!taskOrder?.length) return tasks;
    const map = new Map(tasks.map(t => [t.id, t]));
    return taskOrder.map(id => map.get(id)).filter(Boolean) as CoworkTaskLike[];
  }, [tasks, taskOrder]);

  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null;
    return tasks.find(t => t.id === selectedTaskId) || null;
  }, [tasks, selectedTaskId]);

  const refresh = async () => {
    if (!coworkSessionId) return;
    setIsLoading(true);
    setError(null);
    try {
      const snapshot = await CoworkAPI.getState(coworkSessionId);
      const session = snapshot?.session;
      setRoster(session?.roster || []);
      setTasks(session?.tasks || []);
      setTaskOrder(session?.taskOrder || []);
      setSessionState(String(session?.state || ''));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coworkSessionId]);

  useEffect(() => {
    if (!coworkSessionId || !autoListen) return;

    const unsubs = [
      CoworkAPI.onSessionCreated((p: any) => {
        if (p?.coworkSessionId !== coworkSessionId) return;
        if (Array.isArray(p.roster)) setRoster(p.roster);
      }),
      CoworkAPI.onPlanGenerated((p: any) => {
        if (p?.coworkSessionId !== coworkSessionId) return;
        if (Array.isArray(p.tasks)) setTasks(p.tasks);
        if (Array.isArray(p.taskOrder)) setTaskOrder(p.taskOrder);
      }),
      CoworkAPI.onPlanUpdated((p: any) => {
        if (p?.coworkSessionId !== coworkSessionId) return;
        if (Array.isArray(p.tasks)) setTasks(p.tasks);
        if (Array.isArray(p.taskOrder)) setTaskOrder(p.taskOrder);
      }),
      CoworkAPI.onTaskStateChanged((p: any) => {
        if (p?.coworkSessionId !== coworkSessionId) return;
        const taskId = p?.taskId;
        if (!taskId) return;
        setTasks(prev =>
          prev.map(t => (t.id === taskId ? { ...t, state: p.state || t.state, assignee: p.assignee || t.assignee, error: p.error ?? t.error } : t))
        );
      }),
      CoworkAPI.onTaskOutput((p: any) => {
        if (p?.coworkSessionId !== coworkSessionId) return;
        const taskId = p?.taskId;
        if (!taskId) return;
        setTasks(prev => prev.map(t => (t.id === taskId ? { ...t, outputText: p.outputText || t.outputText } : t)));
      }),
      CoworkAPI.onSessionState((p: any) => {
        if (p?.coworkSessionId !== coworkSessionId) return;
        setSessionState(String(p.state || ''));
      }),
    ];

    return () => {
      unsubs.forEach(u => u());
    };
  }, [coworkSessionId, autoListen]);

  useEffect(() => {
    if (orderedTasks.length === 0) {
      setLayout(null);
      return;
    }

    let cancelled = false;

    const runLayout = async () => {
      setError(null);
      try {
        const nodeWidth = 260;
        const nodeHeight = 84;

        const graph: any = {
          id: 'cowork_dag',
          layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.layered.spacing.nodeNodeBetweenLayers': '50',
            'elk.spacing.nodeNode': '28',
            'elk.edgeRouting': 'ORTHOGONAL',
          },
          children: orderedTasks.map(t => ({
            id: t.id,
            width: nodeWidth,
            height: nodeHeight,
          })),
          edges: orderedTasks.flatMap(t =>
            (t.deps || []).map(depId => ({
              id: `${depId}__to__${t.id}`,
              sources: [depId],
              targets: [t.id],
            }))
          ),
        };

        const result = await elk.layout(graph);
        if (cancelled) return;

        const nodes: Record<string, LayoutNode> = {};
        for (const n of result.children || []) {
          nodes[n.id] = {
            id: n.id,
            x: n.x || 0,
            y: n.y || 0,
            width: n.width || nodeWidth,
            height: n.height || nodeHeight,
          };
        }

        const edges: LayoutEdge[] = (result.edges || []).map((e: any) => ({
          id: e.id,
          sections: (e.sections || []).map((s: any) => ({
            startPoint: s.startPoint,
            endPoint: s.endPoint,
            bendPoints: s.bendPoints || [],
          })),
        }));

        const width = (result.width || 0) + 40;
        const height = (result.height || 0) + 40;
        setLayout({ nodes, edges, width, height });
      } catch (e) {
        log.error('DAG layout failed', { error: e });
        setError(e instanceof Error ? e.message : String(e));
      }
    };

    runLayout();
    return () => {
      cancelled = true;
    };
  }, [orderedTasks]);

  if (!coworkSessionId) {
    return (
      <div className="cowork-dag-panel cowork-dag-panel--empty">
        <div className="cowork-dag-panel__empty-text">Missing `coworkSessionId`.</div>
      </div>
    );
  }

  return (
    <div className="cowork-dag-panel">
      <div className="cowork-dag-panel__header">
        <div className="cowork-dag-panel__title">
          <div className="cowork-dag-panel__title-main">Cowork DAG</div>
          <div className="cowork-dag-panel__title-sub">
            <span className="cowork-dag-panel__mono">{coworkSessionId}</span>
            {sessionState ? <span className="cowork-dag-panel__state">· {sessionState}</span> : null}
          </div>
        </div>

        <div className="cowork-dag-panel__actions">
          <Button size="small" variant="secondary" disabled={isLoading} onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {error && <div className="cowork-dag-panel__error">{error}</div>}

      <div className="cowork-dag-panel__body">
        <div className="cowork-dag-panel__graph">
          {layout ? (
            <div className="cowork-dag-panel__graph-scroll">
              <svg
                className="cowork-dag-panel__svg"
                width={layout.width}
                height={layout.height}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
              >
                <defs>
                  <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
                    <path d="M0,0 L9,3 L0,6 Z" className="cowork-dag-panel__arrow" />
                  </marker>
                </defs>

                {layout.edges.map(edge =>
                  edge.sections.map((section, idx) => {
                    const start = section.startPoint;
                    const end = section.endPoint;
                    if (!start || !end) return null;
                    const points = [start, ...(section.bendPoints || []), end];
                    const d = points
                      .map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`))
                      .join(' ');
                    return (
                      <path
                        key={`${edge.id}:${idx}`}
                        d={d}
                        className="cowork-dag-panel__edge"
                        markerEnd="url(#arrow)"
                      />
                    );
                  })
                )}

                {orderedTasks.map(task => {
                  const n = layout.nodes[task.id];
                  if (!n) return null;
                  const isSelected = task.id === selectedTaskId;
                  const assigneeLabel = computeAssigneeLabel(task.assignee, rosterById);
                  return (
                    <g
                      key={task.id}
                      transform={`translate(${n.x}, ${n.y})`}
                      className={`cowork-dag-node ${stateClass(task.state)} ${isSelected ? 'cowork-dag-node--selected' : ''}`}
                      onClick={() => setSelectedTaskId(task.id)}
                    >
                      <rect className="cowork-dag-node__rect" width={n.width} height={n.height} rx={10} ry={10} />
                      <text className="cowork-dag-node__title" x={12} y={26}>
                        {task.title}
                      </text>
                      <text className="cowork-dag-node__meta" x={12} y={48}>
                        {assigneeLabel}
                      </text>
                      <text className="cowork-dag-node__meta" x={12} y={68}>
                        {task.state}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          ) : (
            <div className="cowork-dag-panel__empty">
              {isLoading ? 'Loading…' : 'No tasks yet.'}
            </div>
          )}
        </div>

        <div className="cowork-dag-panel__detail">
          {selectedTask ? (
            <>
              <div className="cowork-dag-panel__detail-title">{selectedTask.title}</div>
              <div className="cowork-dag-panel__detail-meta">
                <div>
                  <strong>Assignee</strong>: {computeAssigneeLabel(selectedTask.assignee, rosterById)}
                </div>
                <div>
                  <strong>State</strong>: {selectedTask.state}
                </div>
              </div>

              <div className="cowork-dag-panel__detail-section">
                <div className="cowork-dag-panel__detail-label">Description</div>
                <div className="cowork-dag-panel__detail-text">{selectedTask.description}</div>
              </div>

              {selectedTask.deps?.length > 0 && (
                <div className="cowork-dag-panel__detail-section">
                  <div className="cowork-dag-panel__detail-label">Deps</div>
                  <div className="cowork-dag-panel__detail-text">{selectedTask.deps.join(', ')}</div>
                </div>
              )}

              {selectedTask.outputText && (
                <div className="cowork-dag-panel__detail-section">
                  <div className="cowork-dag-panel__detail-label">Output</div>
                  <pre className="cowork-dag-panel__detail-pre">{selectedTask.outputText}</pre>
                </div>
              )}

              {selectedTask.error && (
                <div className="cowork-dag-panel__detail-section">
                  <div className="cowork-dag-panel__detail-label">Error</div>
                  <pre className="cowork-dag-panel__detail-pre cowork-dag-panel__detail-pre--error">{String(selectedTask.error)}</pre>
                </div>
              )}
            </>
          ) : (
            <div className="cowork-dag-panel__detail-empty">Select a node to view details.</div>
          )}
        </div>
      </div>
    </div>
  );
};

CoworkDagPanel.displayName = 'CoworkDagPanel';
