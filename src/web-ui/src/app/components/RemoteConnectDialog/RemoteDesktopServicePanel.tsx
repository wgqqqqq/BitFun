import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Field, Input, OverflowText, StatusPill } from '@openbitfun/ui';
import { ArrowUpRight, Link2, Monitor, RefreshCw, Settings2, ShieldCheck } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { remoteDesktopAPI } from '@/infrastructure/api/service-api/RemoteDesktopAPI';
import { deviceDisplayName, type AccountDeviceInfo } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { remoteDesktopService, useRemoteDesktopService } from '@/infrastructure/remote-desktop/RemoteDesktopService';
import { openRemoteDesktopResource } from './remoteDesktopResource';
import { RemoteDesktopTrustSettings } from './RemoteDesktopTrustSettings';
import './RemoteDesktopServicePanel.scss';

type Failure = 'connect' | 'directory' | 'disconnect' | 'open';
const ERRORS: Record<Failure, string> = {
  connect: 'remoteDesktop.serviceFailed', directory: 'remoteDesktop.directoryFailed',
  disconnect: 'remoteDesktop.disconnectFailed', open: 'remoteDesktop.viewerFailedHint',
};

/** Pairing, the remote directory and local grants have separate lifetimes.
 * Merely opening this surface never pairs, captures or grants access. */
export function RemoteDesktopServicePanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n('common');
  const service = useRemoteDesktopService();
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [name, setName] = useState('OpenBitFun Desktop');
  const [devices, setDevices] = useState<AccountDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState<Failure | null>(null);
  const [editing, setEditing] = useState(false);
  const request = useRef(0);
  const editedUrl = useRef(false);
  const connected = service?.connected === true;
  const refresh = useCallback(async () => {
    const captured = ++request.current;
    setRefreshing(true);
    try {
      const next = await remoteDesktopAPI.serviceDevices();
      if (captured === request.current) { setDevices(next); setFailed(previous => previous === 'directory' ? null : previous); }
    } catch { if (captured === request.current) setFailed('directory'); }
    finally { if (captured === request.current) setRefreshing(false); }
  }, []);
  useEffect(() => {
    if (service?.service_url && !editedUrl.current) setUrl(service.service_url);
  }, [service?.service_url]);
  useEffect(() => {
    ++request.current; setDevices([]); setRefreshing(false); setEditing(false); setFailed(null);
    if (!connected) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 15000);
    return () => { ++request.current; clearInterval(timer); };
  }, [service?.generation, connected, refresh]);
  useEffect(() => () => { ++request.current; }, []);
  const connect = async () => {
    if (busy) return;
    setBusy(true); setFailed(null);
    try {
      await remoteDesktopService.connect(url.trim(), key, name.trim());
      setKey(''); setEditing(false); editedUrl.current = false;
    } catch { setFailed('connect'); }
    finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (busy) return;
    setBusy(true); setFailed(null);
    try { await remoteDesktopService.disconnect(); }
    catch { setFailed('disconnect'); }
    finally { setBusy(false); }
  };
  if (!isTauriRuntime()) return <Alert tone="info" message={t('remoteDesktop.serviceDesktopOnly')} />;
  const computers = devices.filter(device => device.device_id !== service?.device_id
    && (!device.device_kind || device.device_kind === 'desktop'))
    .sort((a, b) => Number(b.online) - Number(a.online));
  const localDevice = devices.find(device => device.device_id === service?.device_id);
  const closeSettings = () => {
    setEditing(false); setKey(''); editedUrl.current = false;
    setUrl(service?.service_url ?? '');
    setName(localDevice?.device_name ?? 'OpenBitFun Desktop');
  };
  const form = <form className="remote-desktop-service__form" onSubmit={event => { event.preventDefault(); void connect(); }}>
    <Field controlWidth="fill" label={t('remoteDesktop.serviceAddress')}>
      <Input value={url} onChange={event => { editedUrl.current = true; setUrl(event.target.value); }}
        placeholder="https://desktop.example.com" autoComplete="url" spellCheck={false} disabled={busy} />
    </Field>
    <div className="remote-desktop-service__form-fields">
      <Field controlWidth="fill" label={t('remoteDesktop.servicePairingKey')}>
        <Input type="password" value={key} onChange={event => setKey(event.target.value)} autoComplete="off" disabled={busy} />
      </Field>
      <Field controlWidth="fill" label={t('remoteDesktop.serviceDeviceName')}>
        <Input value={name} onChange={event => setName(event.target.value)} disabled={busy} />
      </Field>
    </div>
    <p className="remote-desktop-service__hint">{t('remoteDesktop.servicePairingHint')}</p>
    <div className="remote-desktop-service__form-actions">
      {connected && <Button variant="text" disabled={busy} onClick={closeSettings}>{t('actions.cancel')}</Button>}
      <Button type="submit" loading={busy} disabled={busy || !url.trim() || !name.trim()}>{t('remoteDesktop.serviceConnect')}</Button>
    </div>
    {connected && <div className="remote-desktop-service__disconnect">
      <p className="remote-desktop-service__hint">{t('remoteDesktop.disconnectHint')}</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void disconnect()}>{t('remoteDesktop.serviceDisconnect')}</Button>
    </div>}
  </form>;

  return <div className="remote-desktop-service" data-openbitfun-component="remote-desktop-service" data-openbitfun-part="root">
    {failed && <Alert tone="error" message={t(ERRORS[failed])} />}
    <section className="remote-desktop-service__service" aria-label={t('remoteDesktop.serviceConnection')}
      data-openbitfun-component="remote-desktop-service" data-openbitfun-part="service">
      <div className="remote-desktop-service__service-heading">
        <span className="remote-desktop-service__service-icon" aria-hidden="true"><Link2 size={18} /></span>
        <div className="remote-desktop-service__service-copy">
          <span className="remote-desktop-service__label">{t('remoteDesktop.serviceConnection')}</span>
          <OverflowText className="remote-desktop-service__endpoint">{connected ? service.service_url : t('remoteDesktop.serviceNotConnected')}</OverflowText>
        </div>
        {connected && <>
          <StatusPill tone="success">{t('remoteDesktop.serviceConnected')}</StatusPill>
          <Button variant="text" size="xs" leadingIcon={<Settings2 size={14} />} aria-expanded={editing}
            aria-controls="remote-desktop-service-form" onClick={() => {
              if (editing) closeSettings();
              else { setUrl(service.service_url ?? ''); setName(localDevice?.device_name ?? name); setKey(''); setEditing(true); }
            }}>{t('remoteDesktop.serviceSettings')}</Button>
        </>}
      </div>
      {(!connected || editing) && <div id="remote-desktop-service-form" className="remote-desktop-service__setup"
        data-openbitfun-component="remote-desktop-service" data-openbitfun-part="setup">
        {!connected && <div className="remote-desktop-service__setup-heading">
          <h3>{t('remoteDesktop.setupTitle')}</h3>
          <p className="remote-desktop-service__hint">{t('remoteDesktop.setupHint')}</p>
        </div>}
        {form}
      </div>}
    </section>

    {connected ? <>
      <section className="remote-desktop-service__devices" aria-labelledby="remote-desktop-computers-title"
        data-openbitfun-component="remote-desktop-service" data-openbitfun-part="deviceList" aria-busy={refreshing}>
        <div className="remote-desktop-service__section-heading">
          <div><h3 id="remote-desktop-computers-title">{t('remoteDesktop.connectComputers')}</h3>
            <p className="remote-desktop-service__hint">{t('remoteDesktop.connectComputersHint')}</p></div>
          <Button size="xs" variant="text" leadingIcon={<RefreshCw size={14} />} disabled={refreshing}
            onClick={() => void refresh()}>{t('remoteDesktop.serviceRefresh')}</Button>
        </div>
        {computers.length > 0 ? <div className="remote-desktop-service__device-list">{computers.map(device =>
          <div className="remote-desktop-service__device" key={device.device_id}
            data-openbitfun-component="remote-desktop-service" data-openbitfun-part="deviceCard" data-online={device.online}>
            <div className="remote-desktop-service__monitor" aria-hidden="true"><Monitor size={24} strokeWidth={1.5} /></div>
            <div className="remote-desktop-service__device-copy">
              <OverflowText className="remote-desktop-service__device-name">{deviceDisplayName(device)}</OverflowText>
              <div className="remote-desktop-service__device-meta"><StatusPill tone={device.online ? 'success' : 'neutral'}>
                {t(device.online ? 'remoteDesktop.deviceOnline' : 'remoteDesktop.deviceOffline')}</StatusPill>
                {device.device_os && <OverflowText>{device.device_os}</OverflowText>}
              </div>
            </div>
            <Button size="sm" variant={device.online ? 'primary' : 'outline'} trailingIcon={<ArrowUpRight size={14} />}
              disabled={!device.online || busy} onClick={() => {
                try {
                  openRemoteDesktopResource(service.service_id!, device, t('remoteDesktop.viewerTabTitle', { device: deviceDisplayName(device) }));
                  onClose();
                } catch { setFailed('open'); }
              }}>{t('remoteDesktop.viewerOpen')}</Button>
          </div>)}
        </div> : <div className="remote-desktop-service__empty" data-openbitfun-component="remote-desktop-service" data-openbitfun-part="emptyState" role="status">
          <Monitor size={30} strokeWidth={1.25} aria-hidden="true" />
          <h4>{t(refreshing ? 'remoteDesktop.loadingComputers' : failed === 'directory' ? 'remoteDesktop.directoryUnavailable' : 'remoteDesktop.noComputers')}</h4>
          <p className="remote-desktop-service__hint">{t('remoteDesktop.addComputerHint')}</p>
        </div>}
      </section>
      <div className="remote-desktop-service__local" data-openbitfun-component="remote-desktop-service" data-openbitfun-part="localAccess">
        <div className="remote-desktop-service__local-identity"><Monitor size={16} aria-hidden="true" />
          <OverflowText>{localDevice ? deviceDisplayName(localDevice) : name}</OverflowText>
          <span>{t('remoteDesktop.thisComputer')}</span>
        </div>
        <RemoteDesktopTrustSettings key={service.generation} devices={devices} localDeviceId={service.device_id!} />
      </div>
    </> : <div className="remote-desktop-service__intro">
      <div><Monitor size={18} aria-hidden="true" /><strong>{t('remoteDesktop.connectComputers')}</strong><p>{t('remoteDesktop.connectIntro')}</p></div>
      <div><ShieldCheck size={18} aria-hidden="true" /><strong>{t('remoteDesktop.localTitle')}</strong><p>{t('remoteDesktop.localIntro')}</p></div>
    </div>}
    <p className="remote-desktop-service__privacy"><ShieldCheck size={14} aria-hidden="true" />{t('remoteDesktop.accessReminder')}</p>
  </div>;
}
