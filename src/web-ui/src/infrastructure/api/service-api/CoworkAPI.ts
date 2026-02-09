/**
 * Cowork API (Tauri commands + events)
 */

import { api } from './ApiClient';
import type { CoworkRosterMember, CoworkSessionSnapshot, CoworkTask } from '@/tools/cowork/types';

export interface CoworkCreateSessionPayload {
  goal: string;
  roster?: CoworkRosterMember[];
}

export const CoworkAPI = {
  async createSession(payload: CoworkCreateSessionPayload): Promise<{ coworkSessionId: string }> {
    return api.invoke('cowork_create_session', {
      request: payload,
    });
  },

  async generatePlan(coworkSessionId: string): Promise<CoworkTask[]> {
    return api.invoke<CoworkTask[]>('cowork_generate_plan', {
      request: { coworkSessionId },
    });
  },

  async updatePlan(coworkSessionId: string, tasks: CoworkTask[], taskOrder?: string[]): Promise<void> {
    return api.invoke('cowork_update_plan', {
      request: { coworkSessionId, tasks, taskOrder: taskOrder ?? [] },
    });
  },

  async start(coworkSessionId: string): Promise<void> {
    return api.invoke('cowork_start', { request: { coworkSessionId } });
  },

  async pause(coworkSessionId: string): Promise<void> {
    return api.invoke('cowork_pause', { request: { coworkSessionId } });
  },

  async cancel(coworkSessionId: string): Promise<void> {
    return api.invoke('cowork_cancel', { request: { coworkSessionId } });
  },

  async getState(coworkSessionId: string): Promise<CoworkSessionSnapshot> {
    return api.invoke<CoworkSessionSnapshot>('cowork_get_state', { request: { coworkSessionId } });
  },

  async submitUserInput(coworkSessionId: string, taskId: string, answers: string[]): Promise<void> {
    return api.invoke('cowork_submit_user_input', { request: { coworkSessionId, taskId, answers } });
  },

  onSessionCreated(callback: (payload: any) => void): () => void {
    return api.listen('cowork://session-created', callback);
  },
  onPlanGenerated(callback: (payload: any) => void): () => void {
    return api.listen('cowork://plan-generated', callback);
  },
  onPlanUpdated(callback: (payload: any) => void): () => void {
    return api.listen('cowork://plan-updated', callback);
  },
  onSessionState(callback: (payload: any) => void): () => void {
    return api.listen('cowork://session-state', callback);
  },
  onTaskStateChanged(callback: (payload: any) => void): () => void {
    return api.listen('cowork://task-state-changed', callback);
  },
  onTaskOutput(callback: (payload: any) => void): () => void {
    return api.listen('cowork://task-output', callback);
  },
  onNeedsUserInput(callback: (payload: any) => void): () => void {
    return api.listen('cowork://needs-user-input', callback);
  },
};

