import React, { useEffect, useRef } from 'react';
import { RelayConnection } from '../services/RelayConnection';
import { RemoteSessionManager } from '../services/RemoteSessionManager';
import { useMobileStore } from '../services/store';

interface PairingPageProps {
  onPaired: (relay: RelayConnection, sessionMgr: RemoteSessionManager) => void;
}

const PairingPage: React.FC<PairingPageProps> = ({ onPaired }) => {
  const { connectionState, setConnectionState, setError, error } = useMobileStore();
  const relayRef = useRef<RelayConnection | null>(null);
  // Track whether pairing has completed so we don't disconnect the live relay on unmount.
  const pairedRef = useRef(false);

  useEffect(() => {
    const hash = window.location.hash;
    const params = new URLSearchParams(hash.replace(/^#\/pair\?/, ''));
    const room = params.get('room');
    const pk = params.get('pk');
    const did = params.get('did');
    const relayWs = params.get('relay');

    if (!room || !pk) {
      setError('Invalid QR code: missing room or public key');
      return;
    }

    // Use the explicit relay WebSocket URL from QR params,
    // falling back to origin + pathname (for backward compat)
    let wsBaseUrl: string;
    if (relayWs) {
      wsBaseUrl = relayWs;
    } else {
      const base = window.location.origin + window.location.pathname.replace(/\/$/, '');
      wsBaseUrl = base.replace(/^https/, 'wss').replace(/^http/, 'ws');
    }

    const relay = new RelayConnection(wsBaseUrl, room, pk, did || '', {
      onStateChange: (state) => {
        setConnectionState(state);
        if (state === 'paired') {
          pairedRef.current = true;
          const sessionMgr = new RemoteSessionManager(relay);
          onPaired(relay, sessionMgr);
        }
      },
      onMessage: () => {},
      onError: (msg) => setError(msg),
    });

    relayRef.current = relay;
    relay.connect();

    return () => {
      // Only disconnect if pairing has not completed.
      // After pairing, the relay is owned by App.tsx and must stay alive.
      if (!pairedRef.current) {
        relay.disconnect();
      }
    };
  }, []);

  const stateLabels: Record<string, string> = {
    disconnected: 'Disconnected',
    connecting: 'Connecting to relay server...',
    connected: 'Connected, exchanging keys...',
    paired: 'Paired! Loading sessions...',
    error: 'Connection error',
  };

  const handleRetry = () => {
    // Reload the page — browser will reconnect and re-join the room.
    window.location.reload();
  };

  const showRetry = (connectionState === 'error' || connectionState === 'disconnected') && !!error;

  return (
    <div className="pairing-page">
      <div className="pairing-page__logo">BitFun</div>
      <div className="pairing-page__spinner">
        {connectionState !== 'error' && connectionState !== 'disconnected' && (
          <div className="spinner" />
        )}
      </div>
      <div className="pairing-page__state">
        {stateLabels[connectionState] || connectionState}
      </div>
      {error && <div className="pairing-page__error">{error}</div>}
      {showRetry && (
        <button className="pairing-page__retry" onClick={handleRetry}>
          Retry
        </button>
      )}
    </div>
  );
};

export default PairingPage;
