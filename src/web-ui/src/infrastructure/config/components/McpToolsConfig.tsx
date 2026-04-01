/**
 * McpToolsConfig — MCP servers only.
 * Tool execution behavior lives on Session Config.
 * Uses settings/mcp-tools for page title/subtitle, settings/mcp for the MCP section.
 */

import React, { useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileJson,
  RefreshCw,
  X,
  Play,
  Square,
  CheckCircle,
  Clock,
  AlertTriangle,
  MinusCircle,
  KeyRound,
  Trash2,
} from 'lucide-react';
import { Button, Textarea, IconButton, Modal } from '@/component-library';
import {
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageContent,
  ConfigPageSection,
  ConfigCollectionItem,
} from './common';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import {
  MCPAPI,
  MCPRemoteOAuthSessionSnapshot,
  MCPServerInfo,
} from '../../api/service-api/MCPAPI';
import { systemAPI } from '../../api/service-api/SystemAPI';
import './McpToolsConfig.scss';

const log = createLogger('McpToolsConfig');

// ─── MCP error classifier (from MCPConfig) ────────────────────────────────────
interface ErrorInfo {
  title: string;
  message: string;
  duration: number;
  suggestions?: string[];
}

function createErrorClassifier(t: (key: string, options?: any) => any) {
  const getSuggestions = (key: string): string[] | undefined => {
    const suggestions = t(key, { returnObjects: true });
    if (!Array.isArray(suggestions)) return undefined;
    return suggestions.map((s) => String(s));
  };

  return function classifyError(error: unknown, context: string = 'operation'): ErrorInfo {
    let errorMessage = t('errors.unknownError');
    if (error instanceof Error) errorMessage = error.message;
    else if (typeof error === 'string') errorMessage = error;

    const normalizedMessage = errorMessage.toLowerCase();
    const matches = (patterns: string[]) => patterns.some((p) => normalizedMessage.includes(p));

    if (matches(['json parsing failed', 'json parse failed', 'invalid json', 'json format']))
      return {
        title: t('errors.jsonFormatError'),
        message: errorMessage,
        duration: 10000,
        suggestions: getSuggestions('errors.suggestions.jsonFormat'),
      };
    if (matches(["config missing 'mcpservers' field", "'mcpservers' field must be an object"]))
      return {
        title: t('errors.configStructureError'),
        message: errorMessage,
        duration: 10000,
        suggestions: getSuggestions('errors.suggestions.configStructure'),
      };
    if (
      matches([
        "must not set both 'command' and 'url'",
        "must provide either 'command' (stdio) or 'url' (sse)",
        "unsupported 'type' value",
        "'type' conflicts with provided fields",
        "(stdio) must provide 'command' field",
        "(sse) must provide 'url' field",
        "'args' field must be an array",
        "'env' field must be an object",
        'config must be an object',
      ])
    )
      return {
        title: t('errors.serverConfigError'),
        message: errorMessage,
        duration: 10000,
        suggestions: getSuggestions('errors.suggestions.serverConfig'),
      };
    if (matches(['permission denied', 'access is denied']))
      return {
        title: t('errors.permissionError'),
        message: errorMessage,
        duration: 15000,
        suggestions: getSuggestions('errors.suggestions.permission'),
      };
    if (matches(['address already in use', 'failed to bind oauth callback listener']))
      return {
        title: t('errors.operationFailed', { context: 'oauth' }),
        message: errorMessage,
        duration: 10000,
        suggestions: [
          'Change the OAuth callback port in the MCP config or stop the process already using it.',
        ],
      };
    if (matches(['authorization timed out', 'oauth authorization timed out']))
      return {
        title: t('errors.operationFailed', { context: 'oauth' }),
        message: errorMessage,
        duration: 10000,
        suggestions: ['Restart OAuth and complete sign-in before the callback window expires.'],
      };
    if (
      matches([
        'failed to write config file',
        'failed to serialize config',
        'failed to save config',
        'io error',
        'write failed',
      ])
    )
      return {
        title: t('errors.fileOperationError'),
        message: errorMessage,
        duration: 10000,
        suggestions: getSuggestions('errors.suggestions.fileOperation'),
      };
    if (matches(['not found']))
      return { title: t('errors.resourceNotFound'), message: errorMessage, duration: 8000 };
    if (
      matches([
        'failed to start mcp server',
        'failed to capture stdin',
        'failed to capture stdout',
        'max restart attempts',
        'process error',
      ])
    )
      return {
        title: t('errors.serverStartError'),
        message: errorMessage,
        duration: 10000,
        suggestions: getSuggestions('errors.suggestions.serverStart'),
      };
    return {
      title: t('errors.operationFailed', { context }),
      message: errorMessage,
      duration: 8000,
      suggestions: getSuggestions('errors.suggestions.default'),
    };
  };
}

const McpToolsConfig: React.FC = () => {
  const { t: tPage } = useTranslation('settings/mcp-tools');
  const { t: tMcp } = useTranslation('settings/mcp');

  const notification = useNotification();
  const classifyError = createErrorClassifier(tMcp);

  // ─── MCP state ─────────────────────────────────────────────────────────────
  const jsonEditorRef = useRef<HTMLTextAreaElement>(null);
  const jsonLintSeqRef = useRef(0);
  const oauthPollTimerRef = useRef<number | null>(null);
  const [servers, setServers] = useState<MCPServerInfo[]>([]);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [showJsonEditor, setShowJsonEditor] = useState(false);
  const [jsonConfig, setJsonConfig] = useState('');
  const [authDialogServer, setAuthDialogServer] = useState<MCPServerInfo | null>(null);
  const [authValue, setAuthValue] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [oauthSession, setOauthSession] = useState<MCPRemoteOAuthSessionSnapshot | null>(null);
  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthCancelling, setOauthCancelling] = useState(false);
  const [jsonLintError, setJsonLintError] = useState<{
    message: string;
    line?: number;
    column?: number;
    position?: number;
  } | null>(null);

  const tryFormatJson = (input: string): string | null => {
    try {
      return JSON.stringify(JSON.parse(input), null, 2);
    } catch {
      return null;
    }
  };

  // ─── MCP effects & handlers ─────────────────────────────────────────────────
  const loadServers = async () => {
    try {
      setMcpLoading(true);
      const serverList = await MCPAPI.getServers();
      setServers(serverList);
    } catch (error) {
      log.error('Failed to load MCP servers', error);
    } finally {
      setMcpLoading(false);
    }
  };

  const loadJsonConfig = async () => {
    try {
      const config = await MCPAPI.loadMCPJsonConfig();
      setJsonConfig(config);
    } catch {
      setJsonConfig(
        JSON.stringify(
          { mcpServers: { 'example-server': { command: 'npx', args: ['-y', '@example/mcp-server'], env: {} } } },
          null,
          2
        )
      );
    }
  };

  const stopOAuthPolling = () => {
    if (oauthPollTimerRef.current !== null) {
      window.clearInterval(oauthPollTimerRef.current);
      oauthPollTimerRef.current = null;
    }
  };

  const handleOAuthSessionUpdate = async (
    serverId: string,
    session: MCPRemoteOAuthSessionSnapshot | null
  ) => {
    setOauthSession(session);

    const status = session?.status;
    if (!status || !['authorized', 'failed', 'cancelled'].includes(status)) {
      return;
    }

    stopOAuthPolling();

    if (status === 'authorized') {
      notification.success(
        session?.message ||
          tMcp('messages.remoteOAuthAuthorized', {
            serverId,
            defaultValue: `OAuth connected for "${serverId}".`,
          }),
        {
          title: tMcp('notifications.saveSuccess'),
          duration: 4000,
        }
      );
      await loadServers();
      closeAuthDialog();
      return;
    }

    if (status === 'failed') {
      notification.error(
        session?.message ||
          tMcp('messages.remoteOAuthFailed', {
            serverId,
            defaultValue: `OAuth failed for "${serverId}".`,
          }),
        {
          title: tMcp('notifications.operationFailed', { defaultValue: 'Operation failed' }),
          duration: 6000,
        }
      );
    }
  };

  const pollOAuthSession = (serverId: string) => {
    stopOAuthPolling();
    oauthPollTimerRef.current = window.setInterval(async () => {
      try {
        const session = await MCPAPI.getRemoteOAuthSession({ serverId });
        await handleOAuthSessionUpdate(serverId, session);
      } catch (error) {
        stopOAuthPolling();
        notification.error(
          error instanceof Error ? error.message : String(error),
          {
            title: tMcp('notifications.operationFailed', { defaultValue: 'Operation failed' }),
            duration: 5000,
          }
        );
      }
    }, 1000);
  };

  useEffect(() => {
    loadServers();
    loadJsonConfig();
  }, []);

  useEffect(() => {
    return () => {
      if (oauthPollTimerRef.current !== null) {
        window.clearInterval(oauthPollTimerRef.current);
        oauthPollTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!showJsonEditor) {
      setJsonLintError(null);
      return;
    }
    const seq = ++jsonLintSeqRef.current;
    const handle = window.setTimeout(() => {
      if (seq !== jsonLintSeqRef.current) return;
      if (!jsonConfig.trim()) {
        setJsonLintError(null);
        return;
      }
      try {
        JSON.parse(jsonConfig);
        setJsonLintError(null);
      } catch (error) {
        if (seq !== jsonLintSeqRef.current) return;
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = rawMessage.replace(/\s+at position \d+$/, '');
        const posMatch =
          rawMessage.match(/position\s+(\d+)/i) ??
          rawMessage.match(/at position\s+(\d+)/i) ??
          rawMessage.match(/char(?:acter)?\s+(\d+)/i);
        const position = posMatch ? Number(posMatch[1]) : undefined;
        if (typeof position === 'number' && Number.isFinite(position)) {
          const prefix = jsonConfig.slice(0, Math.max(0, position));
          const lines = prefix.split('\n');
          setJsonLintError({
            message,
            line: lines.length,
            column: (lines[lines.length - 1]?.length ?? 0) + 1,
            position,
          });
        } else {
          setJsonLintError({ message });
        }
      }
    }, 150);
    return () => window.clearTimeout(handle);
  }, [jsonConfig, showJsonEditor]);

  const handleSaveJsonConfig = async () => {
    try {
      let parsedConfig;
      try {
        parsedConfig = JSON.parse(jsonConfig);
      } catch (parseError) {
        throw new Error(
          tMcp('errors.jsonParseError', {
            message: parseError instanceof Error ? parseError.message : 'Invalid JSON',
          })
        );
      }
      if (!parsedConfig.mcpServers) throw new Error(tMcp('errors.mcpServersRequired'));
      if (typeof parsedConfig.mcpServers !== 'object' || Array.isArray(parsedConfig.mcpServers))
        throw new Error(tMcp('errors.mcpServersMustBeObject'));

      await MCPAPI.saveMCPJsonConfig(jsonConfig);
      notification.success(tMcp('messages.saveSuccess'), {
        title: tMcp('notifications.saveSuccess'),
        duration: 3000,
      });
      setShowJsonEditor(false);

      void (async () => {
        try {
          await loadServers();
          await MCPAPI.initializeServers();
        } catch {
          notification.warning(tMcp('messages.partialStartFailed'), {
            title: tMcp('notifications.partialStartFailed'),
            duration: 5000,
          });
        } finally {
          await loadServers();
          await loadJsonConfig();
        }
      })();
    } catch (error) {
      const errorInfo = classifyError(error, tMcp('actions.saveConfig'));
      let fullMessage = errorInfo.message;
      if (errorInfo.suggestions?.length) {
        fullMessage +=
          '\n\n' +
          tMcp('notifications.suggestionPrefix') +
          '\n' +
          errorInfo.suggestions.map((s) => `• ${s}`).join('\n');
      }
      notification.error(fullMessage, {
        title: errorInfo.title,
        duration: errorInfo.duration,
      });
    }
  };

  const handleJsonEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const value = jsonConfig;
    const indent = '  ';
    const selectionStart = e.currentTarget.selectionStart ?? 0;
    const selectionEnd = e.currentTarget.selectionEnd ?? 0;
    const setSelection = (start: number, end: number) => {
      requestAnimationFrame(() => {
        const el = jsonEditorRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(start, end);
      });
    };

    if (selectionStart === selectionEnd) {
      if (!e.shiftKey) {
        setJsonConfig(value.slice(0, selectionStart) + indent + value.slice(selectionEnd));
        setSelection(selectionStart + indent.length, selectionStart + indent.length);
        return;
      }
      const lineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
      const lineEndIdx = value.indexOf('\n', selectionStart);
      const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
      const line = value.slice(lineStart, lineEnd);
      const removeFromLineStart = (() => {
        if (line.startsWith(indent)) return indent.length;
        if (line.startsWith('\t')) return 1;
        let spaces = 0;
        while (spaces < indent.length && line[spaces] === ' ') spaces++;
        return spaces;
      })();
      if (removeFromLineStart === 0) return;
      setJsonConfig(value.slice(0, lineStart) + line.slice(removeFromLineStart) + value.slice(lineEnd));
      setSelection(
        Math.max(lineStart, selectionStart - removeFromLineStart),
        Math.max(lineStart, selectionStart - removeFromLineStart)
      );
      return;
    }

    let endForLineCalc = selectionEnd;
    if (selectionEnd > 0 && value[selectionEnd - 1] === '\n') endForLineCalc = selectionEnd - 1;
    const lineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
    const nextNewline = value.indexOf('\n', endForLineCalc);
    const lineEnd = nextNewline === -1 ? value.length : nextNewline;
    const selectedBlock = value.slice(lineStart, lineEnd);
    const lines = selectedBlock.split('\n');

    if (!e.shiftKey) {
      const nextBlock = lines.map((l) => indent + l).join('\n');
      setJsonConfig(value.slice(0, lineStart) + nextBlock + value.slice(lineEnd));
      setSelection(selectionStart + indent.length, selectionEnd + indent.length * lines.length);
      return;
    }

    let removedTotal = 0;
    const removedPerLine: number[] = [];
    const nextBlock = lines
      .map((line) => {
        let removed = 0;
        if (line.startsWith(indent)) removed = indent.length;
        else if (line.startsWith('\t')) removed = 1;
        else {
          while (removed < indent.length && line[removed] === ' ') removed++;
        }
        removedPerLine.push(removed);
        removedTotal += removed;
        return line.slice(removed);
      })
      .join('\n');
    const nextStart = Math.max(lineStart, selectionStart - (removedPerLine[0] ?? 0));
    setJsonConfig(value.slice(0, lineStart) + nextBlock + value.slice(lineEnd));
    setSelection(nextStart, Math.max(nextStart, selectionEnd - removedTotal));
  };

  const handleJsonEditorPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (!pasted) return;
    const current = jsonConfig;
    const selectionStart = e.currentTarget.selectionStart ?? 0;
    const selectionEnd = e.currentTarget.selectionEnd ?? 0;
    const isWholeReplace =
      current.trim().length === 0 || (selectionStart === 0 && selectionEnd === current.length);
    if (!isWholeReplace) return;
    const formatted = tryFormatJson(pasted);
    if (!formatted) return;
    e.preventDefault();
    setJsonConfig(formatted);
    requestAnimationFrame(() => {
      jsonEditorRef.current?.focus();
      jsonEditorRef.current?.setSelectionRange(formatted.length, formatted.length);
    });
  };

  const isCommandDrivenServer = (server: MCPServerInfo) => {
    const normalizedType = server.serverType.toLowerCase();
    return normalizedType.includes('local') || normalizedType.includes('container');
  };

  const isRemoteServer = (server: MCPServerInfo) => {
    return server.serverType.toLowerCase().includes('remote');
  };

  const canStartServer = (server: MCPServerInfo) => {
    if (!isCommandDrivenServer(server)) return true;
    return server.commandAvailable !== false;
  };

  const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

  const isLikelyRemoteAuthError = (error: unknown) => {
    const message = getErrorMessage(error).toLowerCase();
    return [
      'auth required',
      'authorization required',
      'authentication required',
      'www-authenticate',
      'status code: 401',
      'status code: 403',
      'unauthorized',
      'forbidden',
    ].some((pattern) => message.includes(pattern));
  };

  const notifyCommandUnavailable = (server: MCPServerInfo) => {
    notification.warning(
      tMcp('messages.commandUnavailable', {
        serverId: server.id,
        defaultValue: `Server "${server.id}" command is unavailable. Check runtime installation or command configuration.`,
      }),
      {
        title: tMcp('notifications.startFailed'),
        duration: 5000,
      }
    );
  };

  const handleStartServer = async (server: MCPServerInfo) => {
    if (!canStartServer(server)) {
      notifyCommandUnavailable(server);
      return;
    }

    const serverId = server.id;
    try {
      await MCPAPI.startServer(serverId);
      notification.success(tMcp('messages.startSuccess', { serverId }), {
        title: tMcp('notifications.startSuccess'),
        duration: 3000,
      });
      await loadServers();
    } catch (error) {
      if (isRemoteServer(server) && isLikelyRemoteAuthError(error)) {
        handleOpenAuthDialog(server);
        if (server.oauthEnabled) {
          void startRemoteOAuthFlow(server);
        }
      }
      notification.error(
        tMcp('messages.startFailed', { serverId }) +
          ': ' +
          getErrorMessage(error),
        { title: tMcp('notifications.startFailed'), duration: 5000 }
      );
    }
  };

  const handleStopServer = async (serverId: string) => {
    try {
      await MCPAPI.stopServer(serverId);
      notification.success(tMcp('messages.stopSuccess', { serverId }), {
        title: tMcp('notifications.stopSuccess'),
        duration: 3000,
      });
      await loadServers();
    } catch (error) {
      notification.error(
        tMcp('messages.stopFailed', { serverId }) +
          ': ' +
          (error instanceof Error ? error.message : String(error)),
        { title: tMcp('notifications.stopFailed'), duration: 5000 }
      );
    }
  };

  const handleRestartServer = async (server: MCPServerInfo) => {
    if (!canStartServer(server)) {
      notifyCommandUnavailable(server);
      return;
    }

    const serverId = server.id;
    try {
      await MCPAPI.restartServer(serverId);
      notification.success(tMcp('messages.restartSuccess', { serverId }), {
        title: tMcp('notifications.restartSuccess'),
        duration: 3000,
      });
      await loadServers();
    } catch (error) {
      if (isRemoteServer(server) && isLikelyRemoteAuthError(error)) {
        handleOpenAuthDialog(server);
        if (server.oauthEnabled) {
          void startRemoteOAuthFlow(server);
        }
      }
      notification.error(
        tMcp('messages.restartFailed', { serverId }) +
          ': ' +
          getErrorMessage(error),
        { title: tMcp('notifications.restartFailed'), duration: 5000 }
      );
    }
  };

  const handleOpenAuthDialog = (server: MCPServerInfo) => {
    setAuthDialogServer(server);
    setAuthValue('');
    setOauthSession(null);
    setOauthStarting(false);
    setOauthCancelling(false);
    stopOAuthPolling();

    if (server.oauthEnabled) {
      void (async () => {
        try {
          const session = await MCPAPI.getRemoteOAuthSession({ serverId: server.id });
          setOauthSession(session);
          if (session && !['authorized', 'failed', 'cancelled'].includes(session.status)) {
            pollOAuthSession(server.id);
          }
        } catch (error) {
          log.warn('Failed to load remote OAuth session', { serverId: server.id, error });
        }
      })();
    }
  };

  const closeAuthDialog = () => {
    stopOAuthPolling();
    setAuthDialogServer(null);
    setAuthValue('');
    setOauthSession(null);
    setOauthStarting(false);
    setOauthCancelling(false);
  };

  const handleCloseAuthDialog = () => {
    if (authSubmitting || oauthCancelling) return;

    if (
      authDialogServer &&
      oauthSession &&
      !['authorized', 'failed', 'cancelled'].includes(oauthSession.status)
    ) {
      setOauthCancelling(true);
      void (async () => {
        try {
          await MCPAPI.cancelRemoteOAuth({ serverId: authDialogServer.id });
        } catch (error) {
          log.warn('Failed to cancel remote OAuth session', {
            serverId: authDialogServer.id,
            error,
          });
        } finally {
          setOauthCancelling(false);
          closeAuthDialog();
        }
      })();
      return;
    }

    closeAuthDialog();
  };

  const handleSaveRemoteAuth = async () => {
    if (!authDialogServer || authSubmitting) return;

    const trimmed = authValue.trim();
    if (!trimmed) {
      notification.warning(
        tMcp('messages.remoteAuthRequired', {
          defaultValue: 'Please provide a Bearer token or full Authorization header value.',
        }),
        {
          title: tMcp('notifications.operationFailed', { defaultValue: 'Operation failed' }),
          duration: 5000,
        }
      );
      return;
    }

    setAuthSubmitting(true);
    try {
      await MCPAPI.updateRemoteAuth({
        serverId: authDialogServer.id,
        authorizationValue: trimmed,
      });
      notification.success(
        tMcp('messages.remoteAuthUpdated', {
          serverId: authDialogServer.id,
          defaultValue: `Updated remote auth for "${authDialogServer.id}".`,
        }),
        {
          title: tMcp('notifications.saveSuccess'),
          duration: 3000,
        }
      );
      closeAuthDialog();
      await loadServers();
    } catch (error) {
      const errorInfo = classifyError(error, tMcp('actions.saveConfig'));
      notification.error(errorInfo.message, {
        title: errorInfo.title,
        duration: errorInfo.duration,
      });
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleClearRemoteAuth = async (server: MCPServerInfo) => {
    try {
      await MCPAPI.clearRemoteAuth({ serverId: server.id });
      notification.success(
        tMcp('messages.remoteAuthCleared', {
          serverId: server.id,
          defaultValue: `Cleared remote auth for "${server.id}".`,
        }),
        {
          title: tMcp('notifications.saveSuccess'),
          duration: 3000,
        }
      );
      if (authDialogServer?.id === server.id) {
        closeAuthDialog();
      }
      await loadServers();
    } catch (error) {
      const errorInfo = classifyError(error, tMcp('actions.saveConfig'));
      notification.error(errorInfo.message, {
        title: errorInfo.title,
        duration: errorInfo.duration,
      });
    }
  };

  const startRemoteOAuthFlow = async (server: MCPServerInfo) => {
    setOauthStarting(true);
    try {
      const session = await MCPAPI.startRemoteOAuth({ serverId: server.id });
      setOauthSession(session);
      if (session.authorizationUrl) {
        await systemAPI.openExternal(session.authorizationUrl);
      }
      pollOAuthSession(server.id);
      notification.success(
        session.message ||
          tMcp('messages.remoteOAuthStarted', {
            serverId: server.id,
            defaultValue: `Opened OAuth sign-in for "${server.id}".`,
          }),
        {
          title: tMcp('notifications.startSuccess'),
          duration: 3000,
        }
      );
    } catch (error) {
      const errorInfo = classifyError(error, tMcp('actions.remoteAuth', { defaultValue: 'Remote auth' }));
      notification.error(errorInfo.message, {
        title: errorInfo.title,
        duration: errorInfo.duration,
      });
    } finally {
      setOauthStarting(false);
    }
  };

  const handleStartRemoteOAuth = async () => {
    if (!authDialogServer || oauthStarting || authSubmitting) return;
    await startRemoteOAuthFlow(authDialogServer);
  };

  const getStatusClass = (status: string): string => {
    const s = status.toLowerCase();
    if (s.includes('healthy') || s.includes('connected')) return 'is-healthy';
    if (s.includes('starting') || s.includes('reconnecting')) return 'is-pending';
    if (s.includes('failed') || s.includes('stopped') || s.includes('auth')) return 'is-error';
    return '';
  };

  const getStatusIcon = (status: string): React.ReactNode => {
    const s = status.toLowerCase();
    if (s.includes('healthy') || s.includes('connected')) return <CheckCircle size={10} />;
    if (s.includes('starting') || s.includes('reconnecting')) return <Clock size={10} />;
    if (s.includes('failed') || s.includes('stopped') || s.includes('auth'))
      return <AlertTriangle size={10} />;
    return <MinusCircle size={10} />;
  };

  const isStopped = (status: string) => {
    const s = status.toLowerCase();
    return s.includes('stopped') || s.includes('failed') || s.includes('auth');
  };

  const getRuntimeSourceLabel = (server: MCPServerInfo) => {
    if (!server.commandSource) {
      return tMcp('server.runtime.unknown', { defaultValue: 'unknown' });
    }
    return server.commandSource === 'managed'
      ? tMcp('server.runtime.managed', { defaultValue: 'managed' })
      : tMcp('server.runtime.system', { defaultValue: 'system' });
  };

  const getOAuthStatusLabel = (session: MCPRemoteOAuthSessionSnapshot | null) => {
    if (!session) {
      return tMcp('server.remoteOAuthIdle', {
        defaultValue: 'Not started yet',
      });
    }

    switch (session.status) {
      case 'awaitingBrowser':
        return tMcp('server.remoteOAuthAwaitingBrowser', {
          defaultValue: 'Waiting to open browser',
        });
      case 'awaitingCallback':
        return tMcp('server.remoteOAuthAwaitingCallback', {
          defaultValue: 'Waiting for provider callback',
        });
      case 'exchangingToken':
        return tMcp('server.remoteOAuthExchangingToken', {
          defaultValue: 'Exchanging authorization code',
        });
      case 'authorized':
        return tMcp('server.remoteOAuthAuthorized', {
          defaultValue: 'Authorized',
        });
      case 'failed':
        return tMcp('server.remoteOAuthFailed', {
          defaultValue: 'Failed',
        });
      case 'cancelled':
        return tMcp('server.remoteOAuthCancelled', {
          defaultValue: 'Cancelled',
        });
      default:
        return session.status;
    }
  };

  const isOAuthFlowActive = !!oauthSession && !['authorized', 'failed', 'cancelled'].includes(oauthSession.status);

  const getOAuthActionLabel = (server: MCPServerInfo) => {
    if (isOAuthFlowActive) {
      return tMcp('actions.restartRemoteOAuth', { defaultValue: 'Restart OAuth' });
    }
    if (server.authSource === 'oauth' && server.authConfigured) {
      return tMcp('actions.reconnectRemoteOAuth', { defaultValue: 'Reconnect with OAuth' });
    }
    return tMcp('actions.startRemoteOAuth', { defaultValue: 'Connect with OAuth' });
  };

  const mcpSectionExtra = (
    <IconButton
      variant="ghost"
      size="small"
      onClick={() => setShowJsonEditor(!showJsonEditor)}
      tooltip={showJsonEditor ? tMcp('actions.backToList') : tMcp('actions.jsonConfig')}
    >
      {showJsonEditor ? <X size={16} /> : <FileJson size={16} />}
    </IconButton>
  );

  const renderServerBadge = (server: MCPServerInfo) => (
    <>
      <span className={`bitfun-mcp-tools__status-badge ${getStatusClass(server.status)}`}>
        {getStatusIcon(server.status)}
        {server.status}
      </span>
      <span className="bitfun-collection-item__badge">{server.serverType}</span>
      {server.oauthEnabled && (
        <span className="bitfun-collection-item__badge">
          {server.authSource === 'oauth' && server.authConfigured
            ? tMcp('server.remoteOAuthConnected', { defaultValue: 'oauth connected' })
            : tMcp('server.remoteOAuthEnabled', { defaultValue: 'oauth ready' })}
        </span>
      )}
      {isCommandDrivenServer(server) && (
        <span
          className={`bitfun-collection-item__badge ${
            server.commandAvailable === false
              ? 'bitfun-mcp-tools__runtime-badge bitfun-mcp-tools__runtime-badge--error'
              : 'bitfun-mcp-tools__runtime-badge bitfun-mcp-tools__runtime-badge--ok'
          }`}
        >
          {server.commandAvailable === false
            ? tMcp('server.runtime.unavailable', { defaultValue: 'command unavailable' })
            : tMcp('server.runtime.available', { defaultValue: 'command available' })}
        </span>
      )}
    </>
  );

  const renderServerControl = (server: MCPServerInfo) => (
    <>
      {isRemoteServer(server) && (
        <IconButton
          size="small"
          variant="ghost"
          onClick={() => handleOpenAuthDialog(server)}
          tooltip={tMcp('actions.remoteAuth', { defaultValue: 'Remote auth' })}
        >
          <KeyRound size={14} />
        </IconButton>
      )}
      {isRemoteServer(server) && server.authConfigured && (
        <IconButton
          size="small"
          variant="ghost"
          onClick={() => handleClearRemoteAuth(server)}
          tooltip={tMcp('actions.clearRemoteAuth', { defaultValue: 'Clear auth' })}
        >
          <Trash2 size={14} />
        </IconButton>
      )}
      {isStopped(server.status) ? (
        <IconButton
          size="small"
          variant="success"
          onClick={() => handleStartServer(server)}
          tooltip={
            canStartServer(server)
              ? tMcp('actions.start')
              : tMcp('messages.commandUnavailable', {
                  serverId: server.id,
                  defaultValue: `Server "${server.id}" command is unavailable.`,
                })
          }
        >
          <Play size={14} />
        </IconButton>
      ) : (
        <IconButton
          size="small"
          variant="warning"
          onClick={() => handleStopServer(server.id)}
          tooltip={tMcp('actions.stop')}
        >
          <Square size={14} />
        </IconButton>
      )}
      <IconButton
        size="small"
        variant="ghost"
        onClick={() => handleRestartServer(server)}
        tooltip={
          canStartServer(server)
            ? tMcp('actions.restart')
            : tMcp('messages.commandUnavailable', {
                serverId: server.id,
                defaultValue: `Server "${server.id}" command is unavailable.`,
              })
        }
      >
        <RefreshCw size={14} />
      </IconButton>
    </>
  );

  const renderServerDetails = (server: MCPServerInfo) => {
    if (!server.statusMessage && !isCommandDrivenServer(server) && !isRemoteServer(server)) return null;

    return (
      <div className="bitfun-mcp-tools__server-details">
        {server.statusMessage && (
          <div className="bitfun-mcp-tools__server-detail-item">
            <span className="bitfun-mcp-tools__server-detail-label">
              {tMcp('server.statusDetail', { defaultValue: 'Status Detail' })}:
            </span>
            <span className="bitfun-mcp-tools__server-detail-value">
              {server.statusMessage}
            </span>
          </div>
        )}
        {isRemoteServer(server) && (
          <>
            <div className="bitfun-mcp-tools__server-detail-item">
              <span className="bitfun-mcp-tools__server-detail-label">
                {tMcp('server.remoteUrl', { defaultValue: 'Remote URL' })}:
              </span>
              <code className="bitfun-mcp-tools__server-detail-value">
                {server.url || '-'}
              </code>
            </div>
            <div className="bitfun-mcp-tools__server-detail-item">
              <span className="bitfun-mcp-tools__server-detail-label">
                {tMcp('server.remoteAuth', { defaultValue: 'Authentication' })}:
              </span>
              <span className="bitfun-mcp-tools__server-detail-value">
                {server.authConfigured
                  ? tMcp('server.remoteAuthConfigured', {
                      defaultValue: `configured${server.authSource ? ` via ${server.authSource}` : ''}`,
                    })
                  : server.oauthEnabled
                    ? tMcp('server.remoteOAuthReady', {
                        defaultValue: 'OAuth configured, authorization required',
                      })
                  : tMcp('server.remoteAuthMissing', { defaultValue: 'not configured' })}
              </span>
            </div>
            {(server.oauthEnabled || server.xaaEnabled) && (
              <div className="bitfun-mcp-tools__server-detail-item">
                <span className="bitfun-mcp-tools__server-detail-label">
                  {tMcp('server.remoteAuthMethod', { defaultValue: 'Auth Method' })}:
                </span>
                <span className="bitfun-mcp-tools__server-detail-value">
                  {server.oauthEnabled && server.xaaEnabled
                    ? tMcp('server.remoteAuthMethodOAuthXaa', {
                        defaultValue: 'OAuth configured, XAA reserved',
                      })
                    : server.oauthEnabled
                      ? tMcp('server.remoteAuthMethodOAuth', { defaultValue: 'OAuth' })
                      : tMcp('server.remoteAuthMethodXaa', { defaultValue: 'XAA' })}
                </span>
              </div>
            )}
          </>
        )}
        {!isCommandDrivenServer(server) ? null : (
          <>
        <div className="bitfun-mcp-tools__server-detail-item">
          <span className="bitfun-mcp-tools__server-detail-label">
            {tMcp('server.command', { defaultValue: 'Command' })}:
          </span>
          <code className="bitfun-mcp-tools__server-detail-value">
            {server.command || '-'}
          </code>
        </div>
        <div className="bitfun-mcp-tools__server-detail-item">
          <span className="bitfun-mcp-tools__server-detail-label">
            {tMcp('server.runtime.source', { defaultValue: 'Source' })}:
          </span>
          <span className="bitfun-mcp-tools__server-detail-value">
            {getRuntimeSourceLabel(server)}
          </span>
        </div>
        {server.commandResolvedPath && (
          <div className="bitfun-mcp-tools__server-detail-item">
            <span className="bitfun-mcp-tools__server-detail-label">
              {tMcp('server.runtime.path', { defaultValue: 'Resolved Path' })}:
            </span>
            <code className="bitfun-mcp-tools__server-detail-value">
              {server.commandResolvedPath}
            </code>
          </div>
        )}
          </>
        )}
      </div>
    );
  };

  return (
    <ConfigPageLayout className="bitfun-mcp-tools">
      <ConfigPageHeader title={tPage('title')} subtitle={tPage('subtitle')} />

      <ConfigPageContent>
        {/* MCP section */}
        <ConfigPageSection
          title={tMcp('section.serverList.title')}
          description={tMcp('section.serverList.description')}
          extra={mcpSectionExtra}
        >
          {showJsonEditor && (
            <div className="bitfun-mcp-tools__json-editor">
              <div className="bitfun-mcp-tools__json-editor-header">
                <h3>{tMcp('jsonEditor.title')}</h3>
                <p className="bitfun-mcp-tools__json-hint">{tMcp('jsonEditor.hint1')}</p>
                <p className="bitfun-mcp-tools__json-hint">{tMcp('jsonEditor.hint2')}</p>
              </div>
              <Textarea
                ref={jsonEditorRef}
                value={jsonConfig}
                onChange={(e) => setJsonConfig(e.target.value)}
                onKeyDown={handleJsonEditorKeyDown}
                onPaste={handleJsonEditorPaste}
                rows={18}
                placeholder={`{\n  "mcpServers": {\n    "server-name": {\n      "command": "npx",\n      "args": ["-y", "@package/name"],\n      "env": {}\n    }\n  }\n}`}
                variant="outlined"
                className="bitfun-mcp-tools__json-textarea"
                spellCheck={false}
                error={!!jsonLintError}
                errorMessage={
                  jsonLintError
                    ? tMcp('jsonEditor.lintError', {
                        location:
                          typeof jsonLintError.line === 'number' && typeof jsonLintError.column === 'number'
                            ? tMcp('jsonEditor.lintLocation', {
                                line: jsonLintError.line,
                                column: jsonLintError.column,
                              })
                            : '',
                        message: jsonLintError.message,
                      })
                    : undefined
                }
              />
              <div className="bitfun-mcp-tools__json-actions">
                <Button variant="secondary" onClick={() => setShowJsonEditor(false)}>
                  {tMcp('actions.cancel')}
                </Button>
                <Button variant="primary" onClick={handleSaveJsonConfig}>
                  {tMcp('actions.saveConfig')}
                </Button>
              </div>
              <div className="bitfun-mcp-tools__json-examples">
                <h4>{tMcp('jsonEditor.exampleTitle')}</h4>
                <div className="bitfun-mcp-tools__example">
                  <h5>{tMcp('jsonEditor.localProcess')}</h5>
                  <pre>{`{\n  "mcpServers": {\n    "zai-mcp-server": {\n      "command": "npx",\n      "args": ["-y", "@z_ai/mcp-server"],\n      "env": { "Z_AI_API_KEY": "your_api_key" }\n    }\n  }\n}`}</pre>
                </div>
                <div className="bitfun-mcp-tools__example">
                  <h5>{tMcp('jsonEditor.remoteService')}</h5>
                  <pre>{`{\n  "mcpServers": {\n    "remote-mcp": {\n      "url": "http://localhost:3000/sse"\n    }\n  }\n}`}</pre>
                </div>
              </div>
            </div>
          )}

          {!showJsonEditor && mcpLoading && (
            <div className="bitfun-collection-empty">
              <p>{tMcp('loading')}</p>
            </div>
          )}

          {!showJsonEditor && !mcpLoading && servers.length === 0 && (
            <div className="bitfun-collection-empty">
              <Button variant="dashed" size="small" onClick={() => setShowJsonEditor(true)}>
                <FileJson size={14} />
                {tMcp('actions.jsonConfig')}
              </Button>
            </div>
          )}

          {!showJsonEditor &&
            servers.map((server) => (
              <ConfigCollectionItem
                key={server.id}
                label={server.name}
                badge={renderServerBadge(server)}
                control={renderServerControl(server)}
                details={renderServerDetails(server)}
              />
            ))}
        </ConfigPageSection>
      </ConfigPageContent>
      <Modal
        isOpen={!!authDialogServer}
        onClose={handleCloseAuthDialog}
        title={
          authDialogServer
            ? tMcp('modal.remoteAuthTitle', {
                serverName: authDialogServer.name,
                defaultValue: `Remote auth: ${authDialogServer.name}`,
              })
            : tMcp('modal.remoteAuthTitle', { defaultValue: 'Remote auth' })
        }
        size="medium"
        showCloseButton={!authSubmitting && !oauthCancelling}
      >
        {authDialogServer && (
          <div className="bitfun-mcp-tools__json-editor">
            {authDialogServer.oauthEnabled && (
              <>
                <p className="bitfun-mcp-tools__json-hint">
                  {tMcp('modal.remoteOAuthHint', {
                    defaultValue: 'Use OAuth to connect this remote MCP server. BitFun will listen on a local callback URL and reconnect the server after authorization.',
                  })}
                </p>
                <p className="bitfun-mcp-tools__json-hint">
                  {tMcp('modal.remoteOAuthCurrentStatus', {
                    defaultValue: `OAuth state: ${getOAuthStatusLabel(oauthSession)}`,
                    status: getOAuthStatusLabel(oauthSession),
                  })}
                </p>
                {oauthSession?.redirectUri && (
                  <p className="bitfun-mcp-tools__json-hint">
                    {tMcp('modal.remoteOAuthRedirectUri', {
                      defaultValue: `Callback URL: ${oauthSession.redirectUri}`,
                      redirectUri: oauthSession.redirectUri,
                    })}
                  </p>
                )}
                {oauthSession?.message && (
                  <p className="bitfun-mcp-tools__json-hint">
                    {tMcp('modal.remoteOAuthStatus', {
                      defaultValue: `OAuth status: ${oauthSession.status} - ${oauthSession.message}`,
                      status: oauthSession.status,
                      message: oauthSession.message,
                    })}
                  </p>
                )}
                <div className="bitfun-mcp-tools__json-actions">
                  <Button
                    variant="primary"
                    onClick={handleStartRemoteOAuth}
                    isLoading={oauthStarting}
                    disabled={authSubmitting || oauthCancelling}
                  >
                    {getOAuthActionLabel(authDialogServer)}
                  </Button>
                </div>
              </>
            )}
            <p className="bitfun-mcp-tools__json-hint">
              {tMcp('modal.remoteAuthHint', {
                defaultValue: 'Paste a Bearer token or a full Authorization header value. Saving will restart the remote MCP server.',
              })}
            </p>
            {authDialogServer.url && (
              <p className="bitfun-mcp-tools__json-hint">
                {tMcp('modal.remoteAuthServerUrl', {
                  url: authDialogServer.url,
                  defaultValue: `Server URL: ${authDialogServer.url}`,
                })}
              </p>
            )}
            <Textarea
              value={authValue}
              onChange={(e) => setAuthValue(e.target.value)}
              rows={4}
              placeholder={tMcp('modal.remoteAuthPlaceholder', {
                defaultValue: 'Bearer eyJ... or eyJ...',
              })}
              variant="outlined"
              className="bitfun-mcp-tools__json-textarea"
              spellCheck={false}
            />
            <div className="bitfun-mcp-tools__json-actions">
              <Button
                variant="secondary"
                onClick={handleCloseAuthDialog}
                disabled={authSubmitting || oauthStarting || oauthCancelling}
              >
                {isOAuthFlowActive
                  ? tMcp('actions.cancelRemoteOAuth', { defaultValue: 'Cancel OAuth' })
                  : tMcp('actions.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={handleSaveRemoteAuth}
                isLoading={authSubmitting}
                disabled={oauthStarting || oauthCancelling}
              >
                {tMcp('actions.saveRemoteAuth', { defaultValue: 'Save and reconnect' })}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </ConfigPageLayout>
  );
};

export default McpToolsConfig;
