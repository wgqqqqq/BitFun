import React, { useMemo } from 'react';
import { Card, CardBody, CardHeader, Button } from '@/component-library';
import './CoworkSummaryCard.scss';

export interface CoworkSummary {
  coworkSessionId?: string;
  sessionState?: string;
  phaseHint?: string;
  completed: number;
  total: number;
  runningTitles: string[];
  queuedTitles: string[];
  failedTitles: string[];
  waitingTaskId?: string | null;
  questions?: string[];
}

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

export function CoworkSummaryCard(props: { summary: CoworkSummary }): React.ReactElement {
  const { summary } = props;

  const progressPct = useMemo(() => {
    if (!summary.total) return 0;
    return Math.max(0, Math.min(100, Math.round((summary.completed / summary.total) * 100)));
  }, [summary.completed, summary.total]);

  const headerExtra = summary.coworkSessionId ? (
    <Button
      variant="ghost"
      size="small"
      onClick={() => openCoworkDagTab(summary.coworkSessionId!)}
    >
      Open DAG
    </Button>
  ) : null;

  return (
    <Card className="cowork-summary-card" variant="subtle" fullWidth padding="medium">
      <CardHeader
        title={<div className="cowork-summary-card__title">Cowork</div>}
        subtitle={
          summary.phaseHint ? <div className="cowork-summary-card__subtitle">{summary.phaseHint}</div> : undefined
        }
        extra={headerExtra}
      />
      <CardBody>
        {summary.total > 0 ? (
          <div className="cowork-summary-card__progress">
            <div className="cowork-summary-card__progress-row">
              <div className="cowork-summary-card__progress-text">
                Completed <strong>{summary.completed}/{summary.total}</strong> tasks
              </div>
              <div className="cowork-summary-card__progress-pct">{progressPct}%</div>
            </div>
            <div className="cowork-summary-card__progress-bar">
              <div className="cowork-summary-card__progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        ) : null}

        {summary.runningTitles?.length ? (
          <div className="cowork-summary-card__section">
            <div className="cowork-summary-card__section-title">In Progress</div>
            <ul className="cowork-summary-card__list">
              {summary.runningTitles.slice(0, 2).map(t => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {summary.queuedTitles?.length ? (
          <div className="cowork-summary-card__section">
            <div className="cowork-summary-card__section-title">Up Next</div>
            <ul className="cowork-summary-card__list">
              {summary.queuedTitles.slice(0, 2).map(t => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {summary.failedTitles?.length ? (
          <div className="cowork-summary-card__section">
            <div className="cowork-summary-card__section-title">Needs Attention</div>
            <ul className="cowork-summary-card__list cowork-summary-card__list--danger">
              {summary.failedTitles.slice(0, 2).map(t => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {summary.waitingTaskId && summary.questions?.length ? (
          <div className="cowork-summary-card__section">
            <div className="cowork-summary-card__section-title">Needs your input</div>
            <div className="cowork-summary-card__hint">
              Task <code>{summary.waitingTaskId}</code> asks:
            </div>
            <ul className="cowork-summary-card__list">
              {summary.questions.map((q, idx) => (
                <li key={`${idx}-${q}`}>{q}</li>
              ))}
            </ul>
            <div className="cowork-summary-card__hint">Reply in chat with your answers (one per line).</div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

