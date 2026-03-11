/**
 * Completion step
 * CompletionStep - shows model status and get started button
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, ArrowRight } from 'lucide-react';
import { useOnboardingStore, isModelConfigComplete } from '../../store/onboardingStore';

interface CompletionStepProps {
  onComplete: () => void;
}

export const CompletionStep: React.FC<CompletionStepProps> = ({
  onComplete
}) => {
  const { t } = useTranslation('onboarding');
  const { modelConfig } = useOnboardingStore();

  const hasModel = isModelConfigComplete(modelConfig);

  return (
    <div className="bitfun-onboarding-step bitfun-onboarding-completion">
      {/* Success icon */}
      <div className="bitfun-onboarding-completion__success-icon">
        <CheckCircle />
      </div>

      {/* Title */}
      <div className="bitfun-onboarding-step__header">
        <h1 className="bitfun-onboarding-step__title">
          {t('completion.title')}
        </h1>
        <p className="bitfun-onboarding-step__subtitle">
          {t('completion.subtitle')}
        </p>
      </div>

      {/* Model status hint - only show warning when not configured */}
      {!hasModel && (
        <div className="bitfun-onboarding-completion__model-status bitfun-onboarding-completion__model-status--not-configured">
          <span>{t('completion.modelStatus.notConfigured')}</span>
        </div>
      )}

      {/* Get started button */}
      <button 
        className="bitfun-onboarding-completion__start-btn"
        onClick={onComplete}
      >
        {t('completion.startButton')}
        <ArrowRight size={20} />
      </button>
    </div>
  );
};

export default CompletionStep;
