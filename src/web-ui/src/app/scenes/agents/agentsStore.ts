/**
 * Agents scene state management
 */
import { create } from 'zustand';
import type { SubagentInfo } from '@/infrastructure/api/service-api/SubagentAPI';

export const CAPABILITY_CATEGORIES = ['编码', '文档', '分析', '测试', '创意', '运维'] as const;
export type CapabilityCategory = (typeof CAPABILITY_CATEGORIES)[number];

/** 'mode' = primary agent mode (e.g. Agentic/Plan/Debug); 'subagent' = sub-agent */
export type AgentKind = 'mode' | 'subagent';

export interface AgentCapability {
  category: CapabilityCategory;
  level: number;
}

export interface AgentWithCapabilities extends SubagentInfo {
  capabilities: AgentCapability[];
  iconKey?: string;
  /** Distinguishes primary agent mode from sub-agent */
  agentKind?: AgentKind;
}

export const CAPABILITY_COLORS: Record<CapabilityCategory, string> = {
  编码: '#60a5fa',
  文档: '#6eb88c',
  分析: '#8b5cf6',
  测试: '#c9944d',
  创意: '#e879a0',
  运维: '#5ea3a3',
};

export type AgentsScenePage = 'home' | 'createAgent';
export type AgentFilterLevel = 'all' | 'builtin' | 'user' | 'project';
export type AgentFilterType = 'all' | 'mode' | 'subagent';

interface AgentsStoreState {
  page: AgentsScenePage;
  searchQuery: string;
  agentFilterLevel: AgentFilterLevel;
  agentFilterType: AgentFilterType;
  setPage: (page: AgentsScenePage) => void;
  setSearchQuery: (query: string) => void;
  setAgentFilterLevel: (filter: AgentFilterLevel) => void;
  setAgentFilterType: (filter: AgentFilterType) => void;
  openHome: () => void;
  openCreateAgent: () => void;
  agentSoloEnabled: Record<string, boolean>;
  setAgentSoloEnabled: (agentId: string, enabled: boolean) => void;
}

export const useAgentsStore = create<AgentsStoreState>((set) => ({
  page: 'home',
  searchQuery: '',
  agentFilterLevel: 'all',
  agentFilterType: 'all',
  setPage: (page) => set({ page }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setAgentFilterLevel: (filter) => set({ agentFilterLevel: filter }),
  setAgentFilterType: (filter) => set({ agentFilterType: filter }),
  openHome: () => set({ page: 'home' }),
  openCreateAgent: () => set({ page: 'createAgent' }),
  agentSoloEnabled: {},
  setAgentSoloEnabled: (agentId, enabled) =>
    set((s) => ({
      agentSoloEnabled: {
        ...s.agentSoloEnabled,
        [agentId]: enabled,
      },
    })),
}));
