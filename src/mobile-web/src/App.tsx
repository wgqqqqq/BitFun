import React, { useState, useCallback, useRef } from 'react';
import PairingPage from './pages/PairingPage';
import WorkspacePage from './pages/WorkspacePage';
import SessionListPage from './pages/SessionListPage';
import ChatPage from './pages/ChatPage';
import { RelayConnection } from './services/RelayConnection';
import { RemoteSessionManager } from './services/RemoteSessionManager';
import { useMobileStore } from './services/store';
import './styles/mobile.scss';

type Page = 'pairing' | 'workspace' | 'sessions' | 'chat';

const App: React.FC = () => {
  const [page, setPage] = useState<Page>('pairing');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSessionName, setActiveSessionName] = useState<string>('Session');
  const relayRef = useRef<RelayConnection | null>(null);
  const sessionMgrRef = useRef<RemoteSessionManager | null>(null);

  const handlePaired = useCallback((relay: RelayConnection, sessionMgr: RemoteSessionManager) => {
    relayRef.current = relay;
    sessionMgrRef.current = sessionMgr;

    relay.setMessageHandler((json: string) => {
      sessionMgr.handleMessage(json);
    });

    // Listen for the initial sync that the desktop pushes right after pairing.
    // This pre-populates workspace + sessions so the list page can render instantly.
    sessionMgr.onInitialSync((data) => {
      const store = useMobileStore.getState();
      if (data.has_workspace) {
        store.setCurrentWorkspace({
          has_workspace: true,
          path: data.path,
          project_name: data.project_name,
          git_branch: data.git_branch,
        });
      }
      store.setSessions(data.sessions);
    });

    setPage('sessions');
  }, []);

  const handleOpenWorkspace = useCallback(() => {
    setPage('workspace');
  }, []);

  const handleWorkspaceReady = useCallback(() => {
    setPage('sessions');
  }, []);

  const handleSelectSession = useCallback((sessionId: string, sessionName?: string) => {
    setActiveSessionId(sessionId);
    setActiveSessionName(sessionName || 'Session');
    setPage('chat');
  }, []);

  const handleBackToSessions = useCallback(() => {
    setActiveSessionId(null);
    setPage('sessions');
  }, []);

  return (
    <div className="mobile-app">
      {page === 'pairing' && <PairingPage onPaired={handlePaired} />}
      {page === 'workspace' && sessionMgrRef.current && (
        <WorkspacePage
          sessionMgr={sessionMgrRef.current}
          onReady={handleWorkspaceReady}
        />
      )}
      {page === 'sessions' && sessionMgrRef.current && (
        <SessionListPage
          sessionMgr={sessionMgrRef.current}
          onSelectSession={handleSelectSession}
          onOpenWorkspace={handleOpenWorkspace}
        />
      )}
      {page === 'chat' && sessionMgrRef.current && activeSessionId && (
        <ChatPage
          sessionMgr={sessionMgrRef.current}
          sessionId={activeSessionId}
          sessionName={activeSessionName}
          onBack={handleBackToSessions}
        />
      )}
    </div>
  );
};

export default App;
