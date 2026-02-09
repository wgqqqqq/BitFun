import React, { useCallback, useMemo, useState } from 'react';
import { Button, Modal, Textarea } from '@/component-library';
import { createLogger } from '@/shared/utils/logger';
import { CoworkAPI } from '@/infrastructure/api/service-api/CoworkAPI';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { DEFAULT_COWORK_ROSTER } from '../../constants/agents';
import './CoworkLauncher.scss';

const log = createLogger('CoworkLauncher');

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

export interface CoworkLauncherProps {
  variant: 'page' | 'modal';
  isOpen?: boolean;
  onClose?: () => void;
  onBack?: () => void;
}

function CoworkLauncherBody(props: { onBack?: () => void; onClose?: () => void }): React.ReactElement {
  const { onBack, onClose } = props;
  const { openWorkspace } = useWorkspaceContext();

  const [goal, setGoal] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canStart = useMemo(() => goal.trim().length > 0 && !isBusy, [goal, isBusy]);

  const handleStart = useCallback(async () => {
    if (!goal.trim()) return;
    setIsBusy(true);
    setError(null);
    try {
      const { coworkSessionId, workspaceRoot } = await CoworkAPI.createSession({
        goal: goal.trim(),
        roster: DEFAULT_COWORK_ROSTER,
      });

      if (workspaceRoot) {
        await openWorkspace(workspaceRoot, {
          addToRecent: false,
          persist: false,
          metadata: {
            source: 'cowork',
            temporary: true,
            coworkSessionId,
          },
        });
      }

      openCoworkDagTab(coworkSessionId);

      await CoworkAPI.generatePlan(coworkSessionId);
      await CoworkAPI.start(coworkSessionId);

      onClose?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('Failed to start cowork', { error: e });
      setError(msg);
    } finally {
      setIsBusy(false);
    }
  }, [goal, openWorkspace, onClose]);

  return (
    <div className="cowork-launcher">
      <div className="cowork-launcher__header">
        <div className="cowork-launcher__title">Cowork</div>
        <div className="cowork-launcher__subtitle">Creates a temporary workspace and runs a multi-agent plan (DAG) in parallel.</div>
      </div>

      <div className="cowork-launcher__form">
        <label className="cowork-launcher__label">Goal</label>
        <Textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Describe what you want the workforce to do…"
          rows={6}
          disabled={isBusy}
        />
        {error ? <div className="cowork-launcher__error">{error}</div> : null}
      </div>

      <div className="cowork-launcher__actions">
        {onBack ? (
          <Button variant="ghost" onClick={onBack} disabled={isBusy}>
            Back
          </Button>
        ) : null}
        <div className="cowork-launcher__actions-spacer" />
        {onClose ? (
          <Button variant="ghost" onClick={onClose} disabled={isBusy}>
            Cancel
          </Button>
        ) : null}
        <Button variant="primary" onClick={handleStart} disabled={!canStart}>
          {isBusy ? 'Starting…' : 'Send'}
        </Button>
      </div>
    </div>
  );
}

export const CoworkLauncher: React.FC<CoworkLauncherProps> = ({ variant, isOpen = true, onClose, onBack }) => {
  if (variant === 'modal') {
    return (
      <Modal isOpen={isOpen} onClose={() => onClose?.()} title="Cowork" size="medium">
        <CoworkLauncherBody onClose={onClose} />
      </Modal>
    );
  }

  return <CoworkLauncherBody onBack={onBack} />;
};

