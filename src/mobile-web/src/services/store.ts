import { create } from 'zustand';
import type { SessionInfo, ChatMessage, WorkspaceInfo } from './RemoteSessionManager';
import type { ConnectionState } from './RelayConnection';

interface MobileStore {
  connectionState: ConnectionState;
  setConnectionState: (s: ConnectionState) => void;

  // Current workspace context (used when creating new sessions)
  currentWorkspace: WorkspaceInfo | null;
  setCurrentWorkspace: (w: WorkspaceInfo | null) => void;

  sessions: SessionInfo[];
  setSessions: (s: SessionInfo[]) => void;
  appendSessions: (s: SessionInfo[]) => void;

  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;

  // Per-session message storage
  messagesBySession: Record<string, ChatMessage[]>;
  getMessages: (sessionId: string) => ChatMessage[];
  setMessages: (sessionId: string, m: ChatMessage[]) => void;
  appendMessage: (sessionId: string, m: ChatMessage) => void;
  updateLastMessage: (sessionId: string, content: string) => void;
  updateLastMessageFull: (sessionId: string, content: string, metadata: Record<string, any>) => void;

  error: string | null;
  setError: (e: string | null) => void;

  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
}

export const useMobileStore = create<MobileStore>((set, get) => ({
  connectionState: 'disconnected',
  setConnectionState: (connectionState) => set({ connectionState }),

  currentWorkspace: null,
  setCurrentWorkspace: (currentWorkspace) => set({ currentWorkspace }),

  sessions: [],
  setSessions: (sessions) => set({ sessions }),
  appendSessions: (newSessions) =>
    set((state) => ({ sessions: [...state.sessions, ...newSessions] })),

  activeSessionId: null,
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),

  messagesBySession: {},
  getMessages: (sessionId: string) => {
    return get().messagesBySession[sessionId] || [];
  },
  setMessages: (sessionId, m) =>
    set((s) => ({
      messagesBySession: { ...s.messagesBySession, [sessionId]: m },
    })),
  appendMessage: (sessionId, m) =>
    set((s) => {
      const prev = s.messagesBySession[sessionId] || [];
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: [...prev, m] },
      };
    }),
  updateLastMessage: (sessionId, content) =>
    set((s) => {
      const msgs = [...(s.messagesBySession[sessionId] || [])];
      if (msgs.length > 0) {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content };
      }
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: msgs },
      };
    }),
  updateLastMessageFull: (sessionId, content, metadata) =>
    set((s) => {
      const msgs = [...(s.messagesBySession[sessionId] || [])];
      if (msgs.length > 0) {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content, metadata };
      }
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: msgs },
      };
    }),

  error: null,
  setError: (error) => set({ error }),

  isStreaming: false,
  setIsStreaming: (isStreaming) => set({ isStreaming }),
}));
