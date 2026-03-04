import React, { useEffect, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { RemoteSessionManager } from '../services/RemoteSessionManager';
import { useMobileStore } from '../services/store';

interface ChatPageProps {
  sessionMgr: RemoteSessionManager;
  sessionId: string;
  sessionName?: string;
  onBack: () => void;
}

interface ToolCallEntry {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  duration?: number;
  startMs: number;
}

interface StreamingAccum {
  thinking: string;
  text: string;
  toolCalls: ToolCallEntry[];
}

/** Renders markdown content with syntax highlighting */
const MarkdownContent: React.FC<{ content: string }> = ({ content }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      code({ className, children, ...props }) {
        const match = /language-(\w+)/.exec(className || '');
        const codeStr = String(children).replace(/\n$/, '');
        return match ? (
          <SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div">
            {codeStr}
          </SyntaxHighlighter>
        ) : (
          <code className={className} {...props}>
            {children}
          </code>
        );
      },
    }}
  >
    {content}
  </ReactMarkdown>
);

/** Desktop-style collapsible thinking block */
const ThinkingBlock: React.FC<{ thinking: string; streaming?: boolean }> = ({ thinking, streaming }) => {
  const [open, setOpen] = useState(false);
  if (!thinking && !streaming) return null;
  const charCount = thinking.length;
  return (
    <div className="chat-thinking">
      <button className="chat-thinking__toggle" onClick={() => setOpen(o => !o)}>
        <span className={`chat-thinking__arrow ${open ? 'is-open' : ''}`}>▷</span>
        <span className="chat-thinking__label">
          {streaming && charCount === 0
            ? 'Thinking...'
            : `Thought for ${charCount} characters`}
        </span>
      </button>
      {open && thinking && (
        <div className="chat-thinking__content">
          <MarkdownContent content={thinking} />
        </div>
      )}
    </div>
  );
};

/** Desktop-style individual tool card */
const ToolCard: React.FC<{ tool: ToolCallEntry; now: number }> = ({ tool, now }) => {
  const [_expanded, setExpanded] = useState(false);

  const durationLabel = tool.status === 'done' && tool.duration != null
    ? `${(tool.duration / 1000).toFixed(1)}s`
    : tool.status === 'running'
    ? `${((now - tool.startMs) / 1000).toFixed(1)}s`
    : '';

  const toolTypeMap: Record<string, string> = {
    'explore': 'Explore',
    'read_file': 'Read',
    'write_file': 'Write',
    'list_directory': 'LS',
    'bash': 'Shell',
    'glob': 'Glob',
    'grep': 'Grep',
    'create_file': 'Write',
    'delete_file': 'Delete',
    'execute_subagent': 'Task',
    'search': 'Search',
  };
  const toolKey = tool.name.toLowerCase().replace(/[\s-]/g, '_');
  const typeLabel = toolTypeMap[toolKey] || toolTypeMap[tool.name] || 'Tool';

  return (
    <div className={`chat-tool-card chat-tool-card--${tool.status}`}>
      <div className="chat-tool-card__row" onClick={() => setExpanded(e => !e)}>
        <span className="chat-tool-card__icon">
          {tool.status === 'running' ? (
            <span className="chat-tool-card__spinner" />
          ) : tool.status === 'done' ? (
            <span className="chat-tool-card__check">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </span>
          ) : (
            <span className="chat-tool-card__error-icon">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            </span>
          )}
        </span>
        <span className="chat-tool-card__name">{tool.name}</span>
        <span className="chat-tool-card__type">{typeLabel}</span>
        {durationLabel && (
          <span className="chat-tool-card__duration">{durationLabel}</span>
        )}
      </div>
    </div>
  );
};

/** Tool list */
const ToolList: React.FC<{ toolCalls: ToolCallEntry[]; now: number }> = ({ toolCalls, now }) => {
  if (!toolCalls || toolCalls.length === 0) return null;
  return (
    <div className="chat-tool-list">
      {toolCalls.map((tc) => (
        <ToolCard key={tc.id} tool={tc} now={now} />
      ))}
    </div>
  );
};

/** Typing indicator dots */
const TypingDots: React.FC = () => (
  <span className="chat-msg__typing">
    <span /><span /><span />
  </span>
);

type AgentMode = 'agentic' | 'Plan' | 'debug';

const MODE_OPTIONS: { id: AgentMode; label: string }[] = [
  { id: 'agentic', label: 'Agentic' },
  { id: 'Plan', label: 'Plan' },
  { id: 'debug', label: 'Debug' },
];

const ChatPage: React.FC<ChatPageProps> = ({ sessionMgr, sessionId, sessionName, onBack }) => {
  const {
    getMessages,
    setMessages,
    appendMessage,
    updateLastMessageFull,
    isStreaming,
    setIsStreaming,
    setError,
    currentWorkspace,
  } = useMobileStore();

  const messages = getMessages(sessionId);
  const [input, setInput] = useState('');
  const [agentMode, setAgentMode] = useState<AgentMode>('agentic');
  const [pendingImages, setPendingImages] = useState<{ name: string; dataUrl: string }[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<StreamingAccum>({ thinking: '', text: '', toolCalls: [] });

  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Live timer for running tools
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isStreaming) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [isStreaming]);

  const loadMessages = useCallback(async (beforeId?: string) => {
    if (isLoadingMore || (!hasMore && beforeId)) return;
    try {
      setIsLoadingMore(true);
      const resp = await sessionMgr.getSessionMessages(sessionId, 50, beforeId);
      if (beforeId) {
        const currentMsgs = getMessages(sessionId);
        setMessages(sessionId, [...resp.messages, ...currentMsgs]);
      } else {
        setMessages(sessionId, resp.messages);
      }
      setHasMore(resp.has_more);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsLoadingMore(false);
    }
  }, [sessionMgr, sessionId, setMessages, setError, getMessages, isLoadingMore, hasMore]);

  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    if (container.scrollTop < 100 && hasMore && !isLoadingMore) {
      const msgs = getMessages(sessionId);
      if (msgs.length > 0) loadMessages(msgs[0].id);
    }
  }, [hasMore, isLoadingMore, getMessages, sessionId, loadMessages]);

  useEffect(() => {
    sessionMgr.subscribeSession(sessionId).catch(console.error);
    loadMessages();

    const unsub = sessionMgr.onStreamEvent((event) => {
      if (event.session_id !== sessionId) return;
      const eventType = event.event_type;

      if (eventType === 'stream_start') {
        streamRef.current = { thinking: '', text: '', toolCalls: [] };
        setIsStreaming(true);
        appendMessage(sessionId, {
          id: `stream-${Date.now()}`,
          role: 'assistant',
          content: '',
          timestamp: new Date().toISOString(),
          metadata: { thinking: '', toolCalls: [] },
        });

        const userInput = event.payload?.user_input;
        if (userInput && userInput.trim()) {
          const currentMsgs = getMessages(sessionId);
          const lastUserMsg = [...currentMsgs].reverse().find(m => m.role === 'user');
          if (!lastUserMsg || lastUserMsg.content !== userInput.trim()) {
            const msgs = getMessages(sessionId);
            const newUserMsg = {
              id: `user-remote-${Date.now()}`,
              role: 'user',
              content: userInput.trim(),
              timestamp: new Date().toISOString(),
            };
            setMessages(sessionId, [
              ...msgs.slice(0, -1),
              newUserMsg,
              msgs[msgs.length - 1],
            ]);
          }
        }
      } else if (eventType === 'text_chunk') {
        streamRef.current.text += event.payload?.text || '';
        updateLastMessageFull(sessionId, streamRef.current.text, {
          thinking: streamRef.current.thinking,
          toolCalls: streamRef.current.toolCalls,
        });
      } else if (eventType === 'thinking_chunk') {
        streamRef.current.thinking += event.payload?.content || '';
        updateLastMessageFull(sessionId, streamRef.current.text, {
          thinking: streamRef.current.thinking,
          toolCalls: streamRef.current.toolCalls,
        });
      } else if (eventType === 'tool_event') {
        const toolEvt = event.payload?.tool_event;
        if (toolEvt?.event_type === 'Started') {
          streamRef.current.toolCalls = [
            ...streamRef.current.toolCalls,
            {
              id: toolEvt.tool_id || `${toolEvt.tool_name}-${Date.now()}`,
              name: toolEvt.tool_name,
              status: 'running',
              startMs: Date.now(),
            },
          ];
          updateLastMessageFull(sessionId, streamRef.current.text, {
            thinking: streamRef.current.thinking,
            toolCalls: streamRef.current.toolCalls,
          });
        } else if (toolEvt?.event_type === 'Completed' || toolEvt?.event_type === 'Succeeded') {
          streamRef.current.toolCalls = streamRef.current.toolCalls.map(tc =>
            (tc.id === toolEvt.tool_id || tc.name === toolEvt.tool_name) && tc.status === 'running'
              ? { ...tc, status: 'done' as const, duration: toolEvt.duration_ms }
              : tc
          );
          updateLastMessageFull(sessionId, streamRef.current.text, {
            thinking: streamRef.current.thinking,
            toolCalls: streamRef.current.toolCalls,
          });
        } else if (toolEvt?.event_type === 'Failed') {
          streamRef.current.toolCalls = streamRef.current.toolCalls.map(tc =>
            (tc.id === toolEvt.tool_id || tc.name === toolEvt.tool_name) && tc.status === 'running'
              ? { ...tc, status: 'error' as const }
              : tc
          );
          updateLastMessageFull(sessionId, streamRef.current.text, {
            thinking: streamRef.current.thinking,
            toolCalls: streamRef.current.toolCalls,
          });
        }
      } else if (eventType === 'stream_end') {
        setIsStreaming(false);
        streamRef.current = { thinking: '', text: '', toolCalls: [] };
        // Reload to get persisted history
        loadMessages();
      } else if (eventType === 'stream_error') {
        setIsStreaming(false);
        setError(event.payload?.error || 'Stream error');
        streamRef.current = { thinking: '', text: '', toolCalls: [] };
      } else if (eventType === 'stream_cancelled') {
        setIsStreaming(false);
        streamRef.current = { thinking: '', text: '', toolCalls: [] };
      }
    });

    return () => {
      unsub();
      sessionMgr.unsubscribeSession(sessionId).catch(console.error);
    };
  }, [sessionId, sessionMgr, setIsStreaming, appendMessage, updateLastMessageFull, setError, setMessages, getMessages]);

  useEffect(() => {
    if (!isLoadingMore) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoadingMore]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const imgs = pendingImages;
    if ((!text && imgs.length === 0) || isStreaming) return;
    setInput('');
    setPendingImages([]);

    const displayParts = [text];
    if (imgs.length > 0) {
      displayParts.push(`[${imgs.length} image(s) attached]`);
    }
    appendMessage(sessionId, {
      id: `user-${Date.now()}`,
      role: 'user',
      content: displayParts.filter(Boolean).join('\n'),
      timestamp: new Date().toISOString(),
    });
    try {
      const imagePayload = imgs.length > 0
        ? imgs.map(i => ({ name: i.name, data_url: i.dataUrl }))
        : undefined;
      await sessionMgr.sendMessage(sessionId, text || '(see attached images)', agentMode, imagePayload);
    } catch (e: any) {
      setError(e.message);
    }
  }, [input, pendingImages, isStreaming, sessionId, sessionMgr, appendMessage, setError, agentMode]);

  const handleImageSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const maxImages = 5;
    const remaining = maxImages - pendingImages.length;
    const toProcess = Array.from(files).slice(0, remaining);

    toProcess.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setPendingImages((prev) => {
          if (prev.length >= maxImages) return prev;
          return [...prev, { name: file.name, dataUrl }];
        });
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  }, [pendingImages.length]);

  const removeImage = useCallback((idx: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCancel = async () => {
    try {
      await sessionMgr.cancelTask(sessionId);
    } catch {
      // best effort
    }
  };

  const workspaceName = currentWorkspace?.project_name || currentWorkspace?.path?.split('/').pop() || '';
  const gitBranch = currentWorkspace?.git_branch;
  const displayName = sessionName || 'Session';

  return (
    <div className="chat-page">
      {/* Header */}
      <div className="chat-page__header">
        <div className="chat-page__header-row">
          <button className="chat-page__back" onClick={onBack} aria-label="Back">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M12 4L6 10L12 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <div className="chat-page__header-center">
            <span className="chat-page__title" title={displayName}>{displayName}</span>
          </div>
          {isStreaming && (
            <button className="chat-page__cancel" onClick={handleCancel}>Stop</button>
          )}
        </div>
        {workspaceName && (
          <div className="chat-page__header-workspace" title={currentWorkspace?.path}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M2 4L8 2L14 4V12L8 14L2 12V4Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <path d="M8 2V14" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M2 4L8 6L14 4" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
            <span className="chat-page__workspace-name">{workspaceName}</span>
            {gitBranch && (
              <span className="chat-page__workspace-branch">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="5" cy="4" r="2" stroke="currentColor" strokeWidth="1.3"/><circle cx="11" cy="4" r="2" stroke="currentColor" strokeWidth="1.3"/><circle cx="5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3"/><path d="M5 6V10M11 6V8C11 9.1046 10.1046 10 9 10H5" stroke="currentColor" strokeWidth="1.3"/></svg>
                {gitBranch}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="chat-page__messages" ref={messagesContainerRef} onScroll={handleScroll}>
        {isLoadingMore && (
          <div className="chat-page__load-more-indicator">Loading older messages…</div>
        )}

        {messages.map((m) => {
          if (m.role === 'system' || m.role === 'tool') return null;

          const thinking: string = m.metadata?.thinking || '';
          const toolCalls: ToolCallEntry[] = m.metadata?.toolCalls || [];
          const isLastMsg = messages.indexOf(m) === messages.length - 1;
          const streamingThis = isStreaming && isLastMsg && m.role === 'assistant';

          if (m.role === 'user') {
            return (
              <div key={m.id} className="chat-msg chat-msg--user">
                <div className="chat-msg__bubble-user">
                  {m.content}
                </div>
              </div>
            );
          }

          // Assistant message
          return (
            <div key={m.id} className="chat-msg chat-msg--assistant">
              {/* Thinking block */}
              {(thinking || (streamingThis && !m.content)) && (
                <ThinkingBlock thinking={thinking} streaming={streamingThis && !thinking && !m.content} />
              )}

              {/* Tool cards */}
              <ToolList toolCalls={toolCalls} now={now} />

              {/* Main content */}
              {m.content ? (
                <div className="chat-msg__assistant-content">
                  <MarkdownContent content={m.content} />
                </div>
              ) : streamingThis && !thinking && toolCalls.length === 0 ? (
                <div className="chat-msg__assistant-content">
                  <TypingDots />
                </div>
              ) : null}
            </div>
          );
        })}

        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div className="chat-page__input-bar">
        <div className="chat-page__input-toolbar">
          <div className="chat-page__mode-selector">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                className={`chat-page__mode-btn${agentMode === opt.id ? ' is-active' : ''}`}
                onClick={() => setAgentMode(opt.id)}
                disabled={isStreaming}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {pendingImages.length > 0 && (
          <div className="chat-page__image-preview-row">
            {pendingImages.map((img, idx) => (
              <div key={idx} className="chat-page__image-thumb">
                <img src={img.dataUrl} alt={img.name} />
                <button className="chat-page__image-remove" onClick={() => removeImage(idx)}>×</button>
              </div>
            ))}
          </div>
        )}

        <div className="chat-page__input-row">
          <button
            className="chat-page__attach-btn"
            onClick={handleImageSelect}
            disabled={isStreaming || pendingImages.length >= 5}
            aria-label="Attach image"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect x="2" y="3" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
              <circle cx="7" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M2 14L6 10L9 13L13 9L18 14" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/gif,image/webp"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <textarea
            ref={inputRef}
            className="chat-page__input"
            placeholder="Type a message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={isStreaming}
          />
          <button
            className={`chat-page__send${isStreaming ? ' is-streaming' : ''}`}
            onClick={handleSend}
            disabled={(!input.trim() && pendingImages.length === 0) || isStreaming}
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M3 10L17 3L10 17V10H3Z" fill="currentColor"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatPage;
