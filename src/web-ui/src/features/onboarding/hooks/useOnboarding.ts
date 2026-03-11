/**
 * First-launch onboarding hook.
 * useOnboarding - wraps onboarding state and actions.
 */

import { useCallback, useEffect, useState } from 'react';
import { useOnboardingStore, STEP_ORDER, type OnboardingStep } from '../store/onboardingStore';
import { onboardingService } from '../services/OnboardingService';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('useOnboarding');

/**
 * Onboarding hook return value.
 */
interface UseOnboardingResult {
  // State
  isOnboardingActive: boolean;
  isFirstLaunch: boolean;
  currentStep: OnboardingStep;
  currentStepIndex: number;
  totalSteps: number;
  completedSteps: OnboardingStep[];
  isLoading: boolean;
  
  // Configuration
  selectedLanguage: string;
  selectedTheme: string;
  
  // Actions
  nextStep: () => void;
  prevStep: () => void;
  goToStep: (step: OnboardingStep) => void;
  skipOnboarding: () => void;
  completeOnboarding: () => Promise<void>;
  startOnboarding: () => void;
  resetOnboarding: () => Promise<void>;
  
  // Configuration actions
  setLanguage: (language: string) => void;
  setTheme: (theme: string) => void;
  
  // Utilities
  isStepCompleted: (step: OnboardingStep) => boolean;
  canGoNext: () => boolean;
  canGoPrev: () => boolean;
}

/**
 * Onboarding hook.
 * @param autoInitialize Whether to auto-initialize (default true)
 * @param forceShow Whether to force onboarding for tests (default false)
 */
export function useOnboarding(
  autoInitialize = true,
  forceShow = false
): UseOnboardingResult {
  const [isLoading, setIsLoading] = useState(true);
  
  const {
    isOnboardingActive,
    isFirstLaunch,
    currentStep,
    completedSteps,
    selectedLanguage,
    selectedTheme,
    modelConfig,
    nextStep: storeNextStep,
    prevStep: storePrevStep,
    goToStep: storeGoToStep,
    skipOnboarding: storeSkipOnboarding,
    completeOnboarding: storeCompleteOnboarding,
    startOnboarding: storeStartOnboarding,
    setLanguage: storeSetLanguage,
    setTheme: storeSetTheme,
  } = useOnboardingStore();
  // Initialize
  useEffect(() => {
    if (autoInitialize) {
      const init = async () => {
        setIsLoading(true);
        try {
          // Temporarily skip first-launch check for testing.
          // When enabling later, pass false for forceShow.
          await onboardingService.initialize(forceShow);
        } catch (error) {
          log.error('Initialization failed', error);
        } finally {
          setIsLoading(false);
        }
      };
      init();
    } else {
      setIsLoading(false);
    }
  }, [autoInitialize, forceShow]);

  // Compute current step index
  const currentStepIndex = STEP_ORDER.indexOf(currentStep);
  const totalSteps = STEP_ORDER.length;

  // Check whether a step is completed
  const isStepCompleted = useCallback((step: OnboardingStep) => {
    return completedSteps.includes(step);
  }, [completedSteps]);

  // Can go to next step
  const canGoNext = useCallback(() => {
    return currentStepIndex < totalSteps - 1;
  }, [currentStepIndex, totalSteps]);

  // Can go to previous step
  const canGoPrev = useCallback(() => {
    return currentStepIndex > 0;
  }, [currentStepIndex]);

  // Complete onboarding
  const completeOnboarding = useCallback(async () => {
    try {
      // Apply configuration
      await onboardingService.applyConfiguration({
        language: selectedLanguage as any,
        theme: selectedTheme as any,
        modelConfig
      });

      // Mark completed
      await onboardingService.markCompleted();
      
      // Update store
      storeCompleteOnboarding();
    } catch (error) {
      log.error('Failed to complete onboarding', error);
      throw error;
    }
  }, [selectedLanguage, selectedTheme, modelConfig, storeCompleteOnboarding]);

  // Reset onboarding
  const resetOnboarding = useCallback(async () => {
    await onboardingService.resetOnboarding();
  }, []);

  // Set language (apply immediately)
  const setLanguage = useCallback(async (language: string) => {
    storeSetLanguage(language as any);
    try {
      const { i18nService } = await import('@/infrastructure/i18n');
      await i18nService.changeLanguage(language as any);
    } catch (error) {
      log.error('Failed to change language', error);
    }
  }, [storeSetLanguage]);

  // Set theme (apply immediately)
  const setTheme = useCallback(async (theme: string) => {
    storeSetTheme(theme as any);
    try {
      const { themeService } = await import('@/infrastructure/theme');
      await themeService.applyTheme(theme as any);
    } catch (error) {
      log.error('Failed to change theme', error);
    }
  }, [storeSetTheme]);

  return {
    // State
    isOnboardingActive,
    isFirstLaunch,
    currentStep,
    currentStepIndex,
    totalSteps,
    completedSteps,
    isLoading,
    
    // Configuration
    selectedLanguage,
    selectedTheme,
    
    // Actions
    nextStep: storeNextStep,
    prevStep: storePrevStep,
    goToStep: storeGoToStep,
    skipOnboarding: storeSkipOnboarding,
    completeOnboarding,
    startOnboarding: storeStartOnboarding,
    resetOnboarding,
    
    // Configuration actions
    setLanguage,
    setTheme,
    
    // Utilities
    isStepCompleted,
    canGoNext,
    canGoPrev
  };
}
