import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Button, Dialog, DialogBody, DialogClose, DialogHeader, DialogHeaderActions,
  DialogHeading, DialogTitle, Field, OverflowText, Select, StatusPill, Switch } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { remoteDesktopService } from '@/infrastructure/remote-desktop/RemoteDesktopService';
import { deviceDisplayName, type AccountDeviceInfo } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { remoteDesktopAPI } from '@/infrastructure/api/service-api/RemoteDesktopAPI';
import { initialDesktopViewState, RemoteDesktopController, type DesktopViewStage, type DesktopViewState } from '@/infrastructure/remote-desktop/RemoteDesktopController';
import { DesktopMediaFrame } from '@/infrastructure/remote-desktop/DesktopMediaFrame';
import { DesktopFullscreen, type DesktopFullscreenState } from '@/infrastructure/remote-desktop/DesktopFullscreen';
import { REMOTE_DESKTOP_QUALITIES, isRemoteDesktopQuality, type RemoteDesktopQuality } from '@/infrastructure/remote-desktop/RemoteDesktopQuality';
import { RemoteDesktopInputSurface, RemoteDesktopTextComposer } from './RemoteDesktopInputSurface';
import './RemoteDesktopViewer.scss';

const STAGES: Record<DesktopViewStage, string> = { idle: 'remoteDesktop.viewerPreparing', probing: 'remoteDesktop.viewerPreparing',
  waiting_for_host: 'remoteDesktop.viewerWaitingForHost',
  choose_display: 'remoteDesktop.chooseDisplay', connecting: 'remoteDesktop.viewerConnecting', observing: 'remoteDesktop.viewerObserving',
  pausing: 'remoteDesktop.viewerPausing', paused: 'remoteDesktop.viewerPaused', resuming: 'remoteDesktop.viewerConnecting',
  loading_sources: 'remoteDesktop.viewerLoadingSources', choose_source: 'remoteDesktop.chooseDisplay', selecting_source: 'remoteDesktop.viewerConnecting',
  setting_quality: 'remoteDesktop.viewerSettingQuality',
  closed: 'remoteDesktop.viewerClosed', failed: 'remoteDesktop.viewerFailed' };
const QUALITY_LABELS: Record<RemoteDesktopQuality, string> = {
  data_saver: 'remoteDesktop.viewerQualityDataSaver', balanced: 'remoteDesktop.viewerQualityBalanced', clear: 'remoteDesktop.viewerQualityClear',
};
const ERRORS: Record<string, string> = {
  host_locked: 'remoteDesktop.viewerHostLocked',
  device_approval_required: 'remoteDesktop.viewerApprovalRequired', permission_required: 'remoteDesktop.viewerPermissionRequired',
  target_unavailable: 'remoteDesktop.viewerTargetUnavailable', target_lost: 'remoteDesktop.viewerDisplayUnavailable',
  attachment_busy: 'remoteDesktop.viewerBusy', cleanup_pending: 'remoteDesktop.viewerCleanupPending',
  controller_context_changed: 'remoteDesktop.viewerIdentityChanged', relay_upgrade_required: 'remoteDesktop.viewerUpgradeRequired',
  protocol_unsupported: 'remoteDesktop.viewerUpgradeRequired', unsupported: 'remoteDesktop.unsupported',
  media_backend_unavailable: 'remoteDesktop.unsupported',
};

/** A separate viewing surface, never a Peer/session/workspace selector. */
export function RemoteDesktopViewer({ device, onClose, embedded = false, isActive = true, registerRetirement }: {
  device: AccountDeviceInfo; onClose(): void; embedded?: boolean; isActive?: boolean;
  registerRetirement?: (retire: () => void) => () => void;
}) {
  const { t, formatNumber } = useI18n('common');
  const frame = useRef<HTMLIFrameElement>(null);
  const surface = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const activeRef = useRef(isActive);
  const opened = useRef(false);
  const controller = useRef<RemoteDesktopController | null>(null);
  const presentation = useRef<DesktopFullscreen | null>(null);
  const [fullscreen, setFullscreen] = useState<DesktopFullscreenState>({ supported: false, active: false, pending: false, failed: false });
  const [state, setState] = useState<DesktopViewState>(initialDesktopViewState);
  const [display, setDisplay] = useState('');
  const [forceRelay, setForceRelay] = useState(false);
  const [scale, setScale] = useState<'fit' | 'actual'>('fit');
  const [mediaAttempt, setMediaAttempt] = useState(0);
  useEffect(() => { setDisplay(''); }, [state.stage]);
  useLayoutEffect(() => { setScale('fit'); }, [state.rendererId]);
  useLayoutEffect(() => {
    if (viewport.current) { viewport.current.scrollLeft = 0; viewport.current.scrollTop = 0; }
  }, [scale, state.rendererId]);
  useLayoutEffect(() => {
    activeRef.current = isActive;
    if (!isActive) void presentation.current?.exit();
    controller.current?.setVisible(isActive);
  }, [isActive]);
  useEffect(() => {
    if (!surface.current) return;
    const owner = new DesktopFullscreen(surface.current, { retireInput: () => controller.current?.releaseControl(), changed: setFullscreen });
    presentation.current = owner;
    return () => { presentation.current = null; owner.dispose(); };
  }, []);
  useEffect(() => {
    if (state.stage === 'failed' || state.stage === 'closed') void presentation.current?.exit();
  }, [state.stage]);
  useEffect(() => {
    if (!frame.current) return;
    let active = true;
    const media = new DesktopMediaFrame(frame.current, event => { void owner.receive(event); }, code => owner.rendererFailed(code));
    const owner = new RemoteDesktopController({ request: remoteDesktopAPI.request, turn: remoteDesktopAPI.turn,
      renderer: command => media.send(command), update: next => { if (active) setState(next); },
      onInvalidated: close => remoteDesktopService.subscribe(() => { void presentation.current?.exit(); close(); }),
      focused: () => document.visibilityState === 'visible' && document.hasFocus()
        && activeRef.current && surface.current?.contains(document.activeElement) === true,
      identifier: () => crypto.randomUUID(), now: () => Date.now() });
    controller.current = owner;
    const retire = () => { void presentation.current?.exit(); owner.close(); };
    const stopRetirement = registerRetirement?.(retire);
    opened.current = false;
    owner.setVisible(activeRef.current);
    const hidden = () => { if (document.visibilityState !== 'visible') retire(); };
    const leaving = retire;
    const blurred = () => owner.releaseControl();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leaving);
    window.addEventListener('blur', blurred);
    if (activeRef.current) { opened.current = true; void owner.open(device); }
    return () => {
      active = false; controller.current = null; stopRetirement?.(); owner.close(); media.dispose();
      void presentation.current?.exit();
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', leaving);
      window.removeEventListener('blur', blurred);
    };
  }, [device, registerRetirement, mediaAttempt]);
  useEffect(() => {
    if (isActive && !opened.current && controller.current) {
      opened.current = true; void controller.current.open(device);
    }
  }, [device, isActive]);
  const chooseSource = async () => {
    const owner = controller.current;
    await presentation.current?.exit();
    if (!owner || owner !== controller.current || !activeRef.current
      || surface.current?.ownerDocument.fullscreenElement === surface.current) return;
    await owner.chooseSource();
  };
  const pauseSource = async () => {
    const owner = controller.current;
    // Preset selection uses the design system's document-level popup layer.
    // Leave this viewer's element fullscreen before exposing that selector.
    if (state.qualitySupported) await presentation.current?.exit();
    if (!owner || owner !== controller.current || !activeRef.current
      || (state.qualitySupported && surface.current?.ownerDocument.fullscreenElement === surface.current)) return;
    await owner.pauseSource();
  };
  const close = () => { void presentation.current?.exit(); controller.current?.close(); onClose(); };
  const viewing = state.stage === 'connecting' || state.stage === 'observing';
  const status = state.stage === 'observing' ? t('remoteDesktop.viewerObserving') : t(STAGES[state.stage]);
  const inputOwner = isActive && state.controlState === 'controlling' && state.controlGeneration ? controller.current : null;
  const content = <section ref={surface} className={`remote-desktop-viewer${inputOwner && state.textSupported ? ' remote-desktop-viewer--with-composer' : ''}`} data-openbitfun-component="remote-desktop-viewer" data-openbitfun-part="root">
        <div className="remote-desktop-viewer__toolbar" data-openbitfun-component="remote-desktop-viewer" data-openbitfun-part="toolbar">
          <OverflowText className="remote-desktop-viewer__device" title={deviceDisplayName(device)}>{deviceDisplayName(device)}</OverflowText>
          <StatusPill tone={inputOwner ? 'accent' : 'neutral'}>{t(inputOwner ? 'remoteDesktop.viewerControlling' : 'remoteDesktop.viewAccess')}</StatusPill>
          <span role="status">{status}</span>
          {state.path !== 'unknown' && <span>{t(state.path === 'relay' ? 'remoteDesktop.viewerRelay' : 'remoteDesktop.viewerDirect')}</span>}
          {(state.stage === 'observing' || fullscreen.active || fullscreen.pending) && <Button size="sm" variant="outline"
            disabled={!fullscreen.supported || fullscreen.pending} title={!fullscreen.supported ? t('remoteDesktop.viewerFullscreenUnsupported') : undefined}
            onClick={() => { if (fullscreen.active) void presentation.current?.exit(); else void presentation.current?.enter(); }}>
            {t(fullscreen.active ? 'remoteDesktop.viewerExitFullscreen' : 'remoteDesktop.viewerFullscreen')}
          </Button>}
          {state.stage === 'observing' && <div className="remote-desktop-viewer__scale" role="group" aria-label={t('remoteDesktop.viewerScale')}>
            {(['fit', 'actual'] as const).map(mode => <Button key={mode} size="sm" variant={scale === mode ? 'secondary' : 'outline'}
              aria-pressed={scale === mode} onClick={() => {
                if (scale === mode) return;
                if (state.controlState !== 'viewing') controller.current?.releaseControl();
                setScale(mode);
              }}>{t(mode === 'fit' ? 'remoteDesktop.viewerFit' : 'remoteDesktop.viewerActualSize')}</Button>)}
          </div>}
          {state.stage === 'observing' && state.controlSupported && <Button size="sm" variant="outline" disabled={fullscreen.pending || state.signalingInterrupted} onClick={event => {
            // WebKit does not focus buttons on mouse/AX activation. Establish
            // this explicit local intent before checking the viewer focus gate.
            event.currentTarget.focus({ preventScroll: true });
            if (state.controlState === 'viewing') void controller.current?.acquireControl();
            else controller.current?.releaseControl();
          }}>{t(state.controlState === 'viewing' ? 'remoteDesktop.viewerStartControl' : 'remoteDesktop.viewerStopControl')}</Button>}
          {state.stage === 'observing' && state.sourceLifecycleSupported && <Button size="sm" variant="outline"
            disabled={state.signalingInterrupted || fullscreen.pending}
            onClick={() => void pauseSource()}>{t('remoteDesktop.viewerPause')}</Button>}
          {state.stage === 'paused' && state.sourceLifecycleSupported && <>
            <Button size="sm" variant="outline" onClick={() => void controller.current?.resumeSource()}>{t('remoteDesktop.viewerResume')}</Button>
            <Button size="sm" variant="outline" onClick={() => void chooseSource()}>{t('remoteDesktop.viewerChangeDisplay')}</Button>
          </>}
          {['loading_sources', 'choose_source'].includes(state.stage) && <Button size="sm" variant="outline"
            onClick={() => controller.current?.cancelSourceChoice()}>{t('remoteDesktop.viewerCancelDisplay')}</Button>}
          {['closed', 'failed'].includes(state.stage) && <Button size="sm" variant="outline"
            onClick={() => setMediaAttempt(attempt => attempt + 1)}>{t('remoteDesktop.viewerReconnect')}</Button>}
          <Button variant="outline" size="sm" onClick={close}>{t('remoteDesktop.viewerDisconnect')}</Button>
        </div>
        {['paused', 'loading_sources', 'choose_source', 'setting_quality'].includes(state.stage) && <Alert tone="info" message={t('remoteDesktop.viewerPausedHint')} />}
        {state.stage === 'paused' && state.qualitySupported && <div className="remote-desktop-viewer__selection" data-openbitfun-component="remote-desktop-viewer" data-openbitfun-part="selection">
          <Field label={t('remoteDesktop.viewerQuality')}>
            <Select aria-label={t('remoteDesktop.viewerQuality')} value={state.quality} disabled={!isActive}
              options={REMOTE_DESKTOP_QUALITIES.map(quality => ({ value: quality, label: t(QUALITY_LABELS[quality]) }))}
              onValueChange={quality => { if (isActive && isRemoteDesktopQuality(quality)) void controller.current?.setQuality(quality); }} />
          </Field>
        </div>}
        {(state.stage === 'choose_display' || state.stage === 'choose_source') && <div className="remote-desktop-viewer__selection" data-openbitfun-component="remote-desktop-viewer" data-openbitfun-part="selection">
          <Field label={t('remoteDesktop.display')}>
            <Select aria-label={t('remoteDesktop.display')} value={display} placeholder={t('remoteDesktop.chooseDisplay')}
              onValueChange={value => setDisplay(String(value))} options={state.displays.map((item, index) => {
                const label = t('remoteDesktop.displayLabel', { index: formatNumber(index + 1), width: formatNumber(item.width), height: formatNumber(item.height) });
                return { value: item.display_id, label: item.display_id === state.selectedDisplayId ? t('remoteDesktop.viewerCurrentDisplay', { label }) : label };
              })} />
          </Field>
          {state.stage === 'choose_display' && <Field label={t('remoteDesktop.viewerForceRelay')}>
            <Switch checked={forceRelay} onCheckedChange={setForceRelay} aria-label={t('remoteDesktop.viewerForceRelay')} />
          </Field>}
          <Button className="remote-desktop-viewer__connect" disabled={!state.displays.some(item => item.display_id === display)} onClick={() => {
            if (state.stage === 'choose_source') void controller.current?.selectSource(display);
            else void controller.current?.attach(display, forceRelay);
          }}>{t(state.stage === 'choose_source' ? 'remoteDesktop.viewerResume' : 'remoteDesktop.viewerConnect')}</Button>
        </div>}
        {state.stage === 'failed' && <Alert tone="error" message={t(ERRORS[state.error] ?? 'remoteDesktop.viewerFailedHint')} />}
        {state.stage === 'closed' && <Alert tone="info" message={t('remoteDesktop.viewerClosedHint')} />}
        {fullscreen.failed && <Alert tone="info" message={t('remoteDesktop.viewerFullscreenFailed')} />}
        {state.signalingInterrupted && <Alert tone="info" message={t('remoteDesktop.viewerSignalingInterrupted')} />}
        {state.controlError && <Alert tone="info" message={t(state.controlError === 'control_busy' ? 'remoteDesktop.viewerControlBusy'
          : state.controlError === 'unsupported_input' ? 'remoteDesktop.viewerUnsupportedKey' : 'remoteDesktop.viewerControlSuspended')} />}
        <div ref={viewport} className={`remote-desktop-viewer__viewport${inputOwner ? ' remote-desktop-viewer__viewport--controlling' : ''}`} hidden={!viewing}
          data-openbitfun-component="remote-desktop-viewer" data-openbitfun-part="viewport"
          onScroll={() => { if (state.controlState !== 'viewing') controller.current?.releaseControl(); }}>
          <div className="remote-desktop-viewer__canvas" data-openbitfun-component="remote-desktop-viewer" data-openbitfun-part="canvas"
            style={scale === 'actual' ? { width: state.width, height: state.height } : undefined}>
          <iframe key={mediaAttempt} ref={frame} tabIndex={-1} title={t('remoteDesktop.viewerScreen')} className="remote-desktop-viewer__media"
            data-openbitfun-component="remote-desktop-viewer" data-openbitfun-part="media" />
          {inputOwner && <RemoteDesktopInputSurface key={`${state.rendererId}:${state.controlGeneration}`} owner={inputOwner}
            renderer={state.rendererId} generation={state.controlGeneration} width={state.width} height={state.height} />}
          </div>
        </div>
        {inputOwner && <p className="remote-desktop-viewer__hint">{t('remoteDesktop.viewerInputHint')}</p>}
        {inputOwner && state.textSupported && <RemoteDesktopTextComposer key={`${state.rendererId}:${state.controlGeneration}`}
          owner={inputOwner} renderer={state.rendererId} generation={state.controlGeneration} />}
      </section>;
  if (embedded) return content;
  return <Dialog open size="2xl" onOpenChange={close} closeOnPointerOutside={false} closeOnEscape={!fullscreen.active && !fullscreen.pending}>
    <DialogHeader>
      <DialogHeading><DialogTitle>{deviceDisplayName(device)}</DialogTitle></DialogHeading>
      <DialogHeaderActions><DialogClose aria-label={t('remoteDesktop.close')} /></DialogHeaderActions>
    </DialogHeader>
    <DialogBody inset="none">
      {content}
    </DialogBody>
  </Dialog>;
}
