import React, { useEffect, useRef, useCallback, useState } from 'react';
import { RemoteSessionManager } from '../services/RemoteSessionManager';
import { useMobileStore } from '../services/store';

const PAGE_SIZE = 30;

interface SessionListPageProps {
  sessionMgr: RemoteSessionManager;
  onSelectSession: (sessionId: string, sessionName?: string) => void;
  onOpenWorkspace: () => void;
}

function formatTime(unixStr: string): string {
  const ts = parseInt(unixStr, 10);
  if (!ts || isNaN(ts)) return '';
  const date = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function agentLabel(agentType: string): string {
  switch (agentType) {
    case 'code':
    case 'agentic':
      return 'Code';
    case 'cowork':
    case 'Cowork':
      return 'Cowork';
    default:
      return agentType || 'Default';
  }
}

const SessionListPage: React.FC<SessionListPageProps> = ({ sessionMgr, onSelectSession, onOpenWorkspace }) => {
  const { sessions, setSessions, appendSessions, setError, currentWorkspace, setCurrentWorkspace } = useMobileStore();
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const offsetRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  /** Load first page for the given workspace and reset the list */
  const loadFirstPage = useCallback(async (workspacePath: string | undefined) => {
    setLoading(true);
    offsetRef.current = 0;
    try {
      const resp = await sessionMgr.listSessions(workspacePath, PAGE_SIZE, 0);
      setSessions(resp.sessions);
      setHasMore(resp.has_more);
      offsetRef.current = resp.sessions.length;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [sessionMgr, setSessions, setError]);

  /** Append next page (triggered on scroll) */
  const loadNextPage = useCallback(async (workspacePath: string | undefined) => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const resp = await sessionMgr.listSessions(workspacePath, PAGE_SIZE, offsetRef.current);
      appendSessions(resp.sessions);
      setHasMore(resp.has_more);
      offsetRef.current += resp.sessions.length;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [sessionMgr, appendSessions, setError, loadingMore, hasMore]);

  /** On mount: fetch workspace then load first page */
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const info = await sessionMgr.getWorkspaceInfo();
        if (cancelled) return;
        const ws = info.has_workspace ? info : null;
        setCurrentWorkspace(ws);
        await loadFirstPage(ws?.path);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      }
    };
    init();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Scroll handler: detect near-bottom to trigger next page */
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
      loadNextPage(currentWorkspace?.path);
    }
  }, [currentWorkspace?.path, loadNextPage]);

  const handleRefresh = async () => {
    try {
      const info = await sessionMgr.getWorkspaceInfo();
      const ws = info.has_workspace ? info : null;
      setCurrentWorkspace(ws);
      await loadFirstPage(ws?.path);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleCreate = async (agentType: string) => {
    if (creating) return;
    setCreating(true);
    setShowNewMenu(false);
    try {
      const id = await sessionMgr.createSession(agentType, undefined, currentWorkspace?.path);
      // Reload first page to show the new session at the top
      await loadFirstPage(currentWorkspace?.path);
      const agentLabel = agentType === 'cowork' || agentType === 'Cowork' ? 'Remote Cowork Session' : 'Remote Code Session';
      onSelectSession(id, agentLabel);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="session-list">
      <div className="session-list__header">
        <h1>BitFun Sessions</h1>
        <div className="session-list__new-wrapper">
          <button
            className="session-list__new-btn"
            onClick={() => setShowNewMenu(!showNewMenu)}
            disabled={creating}
            style={{ opacity: creating ? 0.5 : 1 }}
          >
            {creating ? 'Creating...' : '+ New'}
          </button>
          {showNewMenu && (
            <div className="session-list__new-menu">
              <button className="session-list__menu-item" onClick={() => handleCreate('code')}>
                <span className="session-list__menu-icon">{'</>'}</span>
                Code Session
              </button>
              <button className="session-list__menu-item" onClick={() => handleCreate('cowork')}>
                <span className="session-list__menu-icon">{'<>'}</span>
                Cowork Session
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Workspace banner — tap to switch */}
      <div className="session-list__workspace-bar" onClick={onOpenWorkspace}>
        <span className="session-list__workspace-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4V12C2 12.5523 2.44772 13 3 13H13C13.5523 13 14 12.5523 14 12V6C14 5.44772 13.5523 5 13 5H8L6.5 3H3C2.44772 3 2 3.44772 2 4Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
        </span>
        <span className="session-list__workspace-name">
          {currentWorkspace?.project_name || currentWorkspace?.path || 'No workspace'}
        </span>
        {currentWorkspace?.git_branch && (
          <span className="session-list__workspace-branch">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="5" cy="4" r="2" stroke="currentColor" strokeWidth="1.3"/><circle cx="11" cy="4" r="2" stroke="currentColor" strokeWidth="1.3"/><circle cx="5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3"/><path d="M5 6V10M11 6V8C11 9.1046 10.1046 10 9 10H5" stroke="currentColor" strokeWidth="1.3"/></svg>
            {currentWorkspace.git_branch}
          </span>
        )}
        <span className="session-list__workspace-switch">Switch ›</span>
      </div>

      <div className="session-list__items" ref={listRef} onScroll={handleScroll}>
        {loading && sessions.length === 0 && (
          <div className="session-list__empty">Loading sessions...</div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="session-list__empty">No sessions yet. Create one to get started.</div>
        )}
        {sessions.map((s) => (
          <div
            key={s.session_id}
            className="session-list__item"
            onClick={() => onSelectSession(s.session_id, s.name)}
          >
            <div className="session-list__item-top">
              <div className="session-list__item-name">{s.name || 'Untitled Session'}</div>
              <span className={`session-list__agent-badge session-list__agent-badge--${s.agent_type}`}>
                {agentLabel(s.agent_type)}
              </span>
            </div>
            <div className="session-list__item-meta">
              <span>{s.message_count} messages</span>
              <span className="session-list__item-time">{formatTime(s.updated_at)}</span>
            </div>
          </div>
        ))}
        {loadingMore && (
          <div className="session-list__load-more">Loading more...</div>
        )}
      </div>

      <button className="session-list__refresh" onClick={handleRefresh} disabled={loading || loadingMore}>
        {loading ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
  );
};

export default SessionListPage;
