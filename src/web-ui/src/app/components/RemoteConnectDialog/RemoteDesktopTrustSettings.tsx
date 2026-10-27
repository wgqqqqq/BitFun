import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Field, OverflowText, Select } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { remoteDesktopAPI, type RemoteDesktopLocalSettings } from '@/infrastructure/api/service-api/RemoteDesktopAPI';
import { deviceDisplayName, type AccountDeviceInfo } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import './RemoteDesktopTrustSettings.scss';

interface Props { devices: AccountDeviceInfo[]; localDeviceId: string; }

/** Local grants are separate from selecting a peer/chat device. Opening this
 * section is explicit; no screen is captured and no request auto-approves. */
export function RemoteDesktopTrustSettings({ devices, localDeviceId }: Props) {
  const { t, formatNumber } = useI18n('common');
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<RemoteDesktopLocalSettings | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [displayId, setDisplayId] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const generation = useRef(0);
  const stopRequest = useRef<Promise<void> | null>(null);
  useEffect(() => () => { generation.current += 1; stopRequest.current = null; }, []);

  const load = async () => {
    const captured = ++generation.current;
    setBusy(true); setFailed(false);
    try {
      const next = await remoteDesktopAPI.settings();
      if (generation.current === captured) {
        setSettings(next);
        setDisplayId(previous => next.displays.some(display => display.display_id === previous) ? previous : '');
      }
    } catch {
      if (generation.current === captured) { setSettings(null); setFailed(true); }
    } finally { if (generation.current === captured) setBusy(false); }
  };

  const mutate = async (operation: () => Promise<void>) => {
    const captured = ++generation.current;
    setBusy(true); setFailed(false);
    try {
      await operation();
      if (generation.current !== captured) return;
      const next = await remoteDesktopAPI.settings();
      if (generation.current === captured) setSettings(next);
    } catch {
      if (generation.current === captured) setFailed(true);
    } finally { if (generation.current === captured) setBusy(false); }
  };
  const stop = async () => {
    if (stopRequest.current) return;
    const captured = ++generation.current;
    setBusy(false); setSettings(null); setStopping(true); setStopFailed(false);
    // Local stop must not wait behind directory reads or grant confirmation.
    // Retire their late results, while allowing a fresh access read afterward.
    const request = Promise.resolve().then(remoteDesktopAPI.stop);
    stopRequest.current = request;
    try {
      await request;
      if (generation.current === captured && open) void load();
    } catch {
      if (stopRequest.current === request) setStopFailed(true);
    } finally {
      if (stopRequest.current === request) { stopRequest.current = null; setStopping(false); }
    }
  };
  const controllerDevices = settings?.controller_devices ?? [];
  const candidates = settings?.controller_directory_state === 'ready' ? controllerDevices
    : settings?.controller_directory_state === 'unavailable' ? [] : devices;
  const eligibleDevices = candidates.filter(device => device.device_id !== localDeviceId
    && device.device_kind !== 'watch' && device.device_kind !== 'cli');
  const canApprove = settings?.storage_available && settings.displays.some(display => display.display_id === displayId)
    && eligibleDevices.some(device => device.device_id === deviceId);

  return <section data-openbitfun-component="remote-account-panel" data-openbitfun-part="trustSettings" className="account-panel__section remote-desktop-trust" aria-labelledby="remote-desktop-trust-title">
    <div className="account-panel__section-heading">
      <h3 id="remote-desktop-trust-title" className="account-panel__section-title">{t('remoteDesktop.localTitle')}</h3>
      <div className="remote-desktop-trust__actions">
        <Button size="xs" variant="outline" disabled={stopping} loading={stopping}
          onClick={() => void stop()}>{t('remoteDesktop.stop')}</Button>
        <Button size="xs" variant="text" aria-expanded={open} aria-controls="remote-desktop-local-access" onClick={() => {
          if (open) { generation.current += 1; setOpen(false); setBusy(false); }
          else { setOpen(true); void load(); }
        }}>{t(open ? 'remoteDesktop.close' : 'remoteDesktop.manage')}</Button>
      </div>
    </div>
    <p className="remote-desktop-trust__hint">{t('remoteDesktop.localAccessHint')}</p>
    {stopFailed && <Alert tone="error" message={t('remoteDesktop.stopFailed')} />}
    {open && <div id="remote-desktop-local-access" className="account-panel__card remote-desktop-trust__body">
      <p className="remote-desktop-trust__hint">{t('remoteDesktop.localHint')}</p>
      {settings?.availability === 'media_backend_unavailable' && <Alert tone="info" message={t('remoteDesktop.mediaPending')} />}
      {settings?.control_grant_supported && !settings.control_available && <Alert tone="info" message={t('remoteDesktop.controlPending')} />}
      {settings?.availability === 'permission_required' && <>
        <Alert tone="info" message={t('remoteDesktop.capturePermissionRequired')} />
        <div className="remote-desktop-trust__actions">
          <Button size="sm" disabled={busy || stopping}
            onClick={() => void mutate(async () => { await remoteDesktopAPI.captureConsent('request'); })}>{t('remoteDesktop.requestCapturePermission')}</Button>
          <Button variant="outline" size="sm" disabled={busy || stopping}
            onClick={() => void mutate(async () => { await remoteDesktopAPI.captureConsent('open_settings'); })}>{t('remoteDesktop.openCaptureSettings')}</Button>
        </div>
      </>}
      {settings?.availability === 'unsupported' && <Alert tone="info" message={t('remoteDesktop.unsupported')} />}
      {failed && <Alert tone="error" message={t('remoteDesktop.failed')} />}
      {settings?.controller_directory_state === 'unsupported' && <Alert tone="info" message={t('remoteDesktop.controllerDirectoryUpgrade')} />}
      {settings?.controller_directory_state === 'unavailable' && <Alert tone="error" message={t('remoteDesktop.controllerDirectoryFailed')} />}
      {settings && !settings.storage_available && <Alert tone="error" message={t('remoteDesktop.storageUnavailable')} />}
      {settings && settings.availability !== 'unsupported' && <>
        <Field controlWidth="fill" label={t('remoteDesktop.controller')}>
          <Select aria-label={t('remoteDesktop.controller')} value={deviceId} onValueChange={value => setDeviceId(String(value))}
            placeholder={t('remoteDesktop.chooseDevice')} disabled={busy || stopping}
            options={eligibleDevices.map(device => ({ value: device.device_id, label: deviceDisplayName(device) }))} />
        </Field>
        <Field controlWidth="fill" label={t('remoteDesktop.display')}>
          <Select aria-label={t('remoteDesktop.display')} value={displayId} onValueChange={value => setDisplayId(String(value))}
            placeholder={t('remoteDesktop.chooseDisplay')} disabled={busy || stopping}
            options={settings.displays.map((display, index) => ({ value: display.display_id,
              label: t('remoteDesktop.displayLabel', { index: formatNumber(index + 1), width: formatNumber(display.width), height: formatNumber(display.height) }) }))} />
        </Field>
        <div className="remote-desktop-trust__actions">
          <Button variant="primary" size="sm" disabled={busy || stopping || !canApprove}
            onClick={() => void mutate(() => remoteDesktopAPI.approveView(deviceId, displayId))}>{t('remoteDesktop.allowView')}</Button>
          {settings.control_grant_supported && <Button variant="outline" size="sm" disabled={busy || stopping || !canApprove}
            onClick={() => void mutate(() => remoteDesktopAPI.approveControl(deviceId, displayId))}>{t('remoteDesktop.allowControl')}</Button>}
        </div>
        <p className="remote-desktop-trust__hint">{t('remoteDesktop.confirmHint')}</p>
        {settings.grants.length === 0 && <p className="remote-desktop-trust__hint">{t('remoteDesktop.noGrants')}</p>}
        {settings.grants.map(grant => <div className="remote-desktop-trust__grant" key={`${grant.device_id}:${grant.public_key_fingerprint}`}>
          <div className="remote-desktop-trust__identity">
            <OverflowText>{deviceDisplayName(controllerDevices.find(device => device.device_id === grant.device_id) ?? devices.find(device => device.device_id === grant.device_id) ?? { device_id: grant.device_id })}</OverflowText>
            <OverflowText title={grant.public_key_fingerprint}>{grant.public_key_fingerprint}</OverflowText>
            <p className="remote-desktop-trust__hint">{t(grant.control_display_ids?.length ? 'remoteDesktop.controlAccess' : 'remoteDesktop.viewAccess')}</p>
          </div>
          <Button size="xs" variant="outline" disabled={busy || stopping}
            onClick={() => void mutate(() => remoteDesktopAPI.revokeView(grant.device_id))}>{t('remoteDesktop.revoke')}</Button>
        </div>)}
      </>}
      <Button size="xs" variant="text" disabled={busy || stopping} onClick={() => void load()}>{t('remoteDesktop.refresh')}</Button>
    </div>}
  </section>;
}
