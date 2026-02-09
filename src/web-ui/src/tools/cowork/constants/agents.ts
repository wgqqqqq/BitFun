import type { CoworkAgentType, CoworkRosterMember } from '../types';

export interface CoworkAgentTypeMeta {
  id: CoworkAgentType;
  label: string;
  description: string;
  defaultSubagentType: string;
}

export const COWORK_AGENT_TYPE_META: ReadonlyArray<CoworkAgentTypeMeta> = [
  {
    id: 'coordinator_agent',
    label: 'Coordinator Agent',
    description: 'Owns orchestration, synchronization, and final delivery quality.',
    defaultSubagentType: 'Explore',
  },
  {
    id: 'task_agent',
    label: 'Task Agent',
    description: 'Handles task decomposition and adaptive scheduling decisions.',
    defaultSubagentType: 'Explore',
  },
  {
    id: 'new_worker_agent',
    label: 'New Worker Agent',
    description: 'Generalist worker slot for dynamic, ad-hoc task assignment.',
    defaultSubagentType: 'Explore',
  },
  {
    id: 'developer_agent',
    label: 'Developer Agent',
    description: 'Implements code changes, refactors, and validation updates.',
    defaultSubagentType: 'Explore',
  },
  {
    id: 'browser_agent',
    label: 'Browser Agent',
    description: 'Performs web research, source verification, and link-based discovery.',
    defaultSubagentType: 'Explore',
  },
  {
    id: 'document_agent',
    label: 'Document Agent',
    description: 'Maintains docs, specs, and communication-ready summaries.',
    defaultSubagentType: 'Explore',
  },
  {
    id: 'multi_modal_agent',
    label: 'Multi Modal Agent',
    description: 'Analyzes diagrams, images, and mixed-format artifacts.',
    defaultSubagentType: 'Explore',
  },
  {
    id: 'social_media_agent',
    label: 'Social Media Agent',
    description: 'Produces external-facing narrative and announcement content.',
    defaultSubagentType: 'Explore',
  },
  {
    id: 'mcp_agent',
    label: 'MCP Agent',
    description: 'Coordinates MCP toolchains and external capability integrations.',
    defaultSubagentType: 'Explore',
  },
];

export const DEFAULT_COWORK_ROSTER: CoworkRosterMember[] = [
  {
    id: 'planner',
    role: 'Planner',
    agentType: 'task_agent',
    subagentType: 'Explore',
    description: 'Decompose goals into tasks and define dependencies.',
  },
  {
    id: 'developer',
    role: 'Developer',
    agentType: 'developer_agent',
    subagentType: 'Explore',
    description: 'Execute implementation tasks and prepare deliverables.',
  },
  {
    id: 'reviewer',
    role: 'Reviewer',
    agentType: 'coordinator_agent',
    subagentType: 'Explore',
    description: 'Review outputs and surface quality issues early.',
  },
  {
    id: 'researcher',
    role: 'Researcher',
    agentType: 'browser_agent',
    subagentType: 'Explore',
    description: 'Investigate unknowns and gather context or evidence.',
  },
];

export const getCoworkAgentTypeLabel = (agentType?: string): string => {
  if (!agentType) return 'Unknown Agent';
  return COWORK_AGENT_TYPE_META.find(item => item.id === agentType)?.label || agentType;
};
