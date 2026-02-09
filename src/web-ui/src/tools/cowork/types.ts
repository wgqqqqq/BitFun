export type CoworkSessionState =
  | 'draft'
  | 'planning'
  | 'ready'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'error';

export type CoworkTaskState =
  | 'draft'
  | 'ready'
  | 'blocked'
  | 'running'
  | 'waiting_user_input'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CoworkAgentType =
  | 'coordinator_agent'
  | 'task_agent'
  | 'new_worker_agent'
  | 'developer_agent'
  | 'browser_agent'
  | 'document_agent'
  | 'multi_modal_agent'
  | 'social_media_agent'
  | 'mcp_agent';

export interface CoworkRosterMember {
  id: string;
  role: string;
  agentType?: CoworkAgentType | string;
  subagentType: string;
  description?: string;
}

export interface CoworkTask {
  id: string;
  title: string;
  description: string;
  deps: string[];
  assignee: string;
  state: CoworkTaskState;
  questions: string[];
  userAnswers: string[];
  outputText: string;
  error?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number | null;
  finishedAtMs?: number | null;
}

export interface CoworkSession {
  coworkSessionId: string;
  goal: string;
  state: CoworkSessionState;
  roster: CoworkRosterMember[];
  taskOrder: string[];
  tasks: CoworkTask[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CoworkSessionSnapshot {
  session: CoworkSession;
}

export interface CoworkTimelineEvent {
  id: string;
  type: string;
  timestamp: number;
  payload: any;
}
