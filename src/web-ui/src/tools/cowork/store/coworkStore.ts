import { create } from 'zustand';
import type { CoworkRosterMember, CoworkSessionState, CoworkTask, CoworkTimelineEvent } from '../types';
import { DEFAULT_COWORK_ROSTER } from '../constants/agents';

interface CoworkState {
  coworkSessionId: string | null;
  goalInput: string;
  sessionState: CoworkSessionState | null;
  roster: CoworkRosterMember[];
  tasks: CoworkTask[];
  taskOrder: string[];
  timeline: CoworkTimelineEvent[];
  error: string | null;

  setGoalInput: (goal: string) => void;
  setError: (error: string | null) => void;
  reset: () => void;

  applySessionCreated: (payload: any) => void;
  applyPlan: (payload: any) => void;
  applySessionState: (payload: any) => void;
  applyTaskStateChanged: (payload: any) => void;
  applyTaskOutput: (payload: any) => void;
  applyNeedsUserInput: (payload: any) => void;
  addTimelineEvent: (type: string, payload: any) => void;
}

const initialRoster: CoworkRosterMember[] = DEFAULT_COWORK_ROSTER;

export const useCoworkStore = create<CoworkState>((set, get) => ({
  coworkSessionId: null,
  goalInput: '',
  sessionState: null,
  roster: initialRoster,
  tasks: [],
  taskOrder: [],
  timeline: [],
  error: null,

  setGoalInput: (goal) => set({ goalInput: goal }),
  setError: (error) => set({ error }),

  reset: () =>
    set({
      coworkSessionId: null,
      goalInput: '',
      sessionState: null,
      roster: initialRoster,
      tasks: [],
      taskOrder: [],
      timeline: [],
      error: null,
    }),

  addTimelineEvent: (type, payload) => {
    const ev: CoworkTimelineEvent = {
      id: `${type}-${Date.now()}-${Math.random()}`,
      type,
      timestamp: Date.now(),
      payload,
    };
    set({ timeline: [ev, ...get().timeline].slice(0, 500) });
  },

  applySessionCreated: (payload) => {
    set({
      coworkSessionId: payload?.coworkSessionId ?? null,
      roster: payload?.roster ?? get().roster,
      sessionState: 'draft',
      tasks: [],
      taskOrder: [],
    });
    get().addTimelineEvent('cowork://session-created', payload);
  },

  applyPlan: (payload) => {
    set({
      tasks: payload?.tasks ?? [],
      taskOrder: payload?.taskOrder ?? [],
      sessionState: 'ready',
    });
    get().addTimelineEvent(payload?.eventName ?? 'cowork://plan', payload);
  },

  applySessionState: (payload) => {
    const state = payload?.state as CoworkSessionState | undefined;
    if (state) {
      set({ sessionState: state });
    }
    get().addTimelineEvent('cowork://session-state', payload);
  },

  applyTaskStateChanged: (payload) => {
    const taskId = payload?.taskId;
    if (!taskId) return;
    const tasks = get().tasks.map(t => (t.id === taskId ? { ...t, state: payload.state ?? t.state, error: payload.error ?? t.error } : t));
    set({ tasks });
    get().addTimelineEvent('cowork://task-state-changed', payload);
  },

  applyTaskOutput: (payload) => {
    const taskId = payload?.taskId;
    if (!taskId) return;
    const tasks = get().tasks.map(t => (t.id === taskId ? { ...t, outputText: payload.outputText ?? t.outputText } : t));
    set({ tasks });
    get().addTimelineEvent('cowork://task-output', payload);
  },

  applyNeedsUserInput: (payload) => {
    get().addTimelineEvent('cowork://needs-user-input', payload);
  },
}));
