import { Alert } from '@openbitfun/ui';
import { useCallback } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { useRemoteDesktopService } from '@/infrastructure/remote-desktop/RemoteDesktopService';
import { useShortcut } from '@/infrastructure/hooks/useShortcut';
import { useSceneStore } from '@/app/stores/sceneStore';
import { registerContentCloseGuard } from '@/app/workbench/contentResourceLifecycle';
import { RemoteDesktopViewer } from './RemoteDesktopViewer';
import type { RemoteDesktopResourceData } from './remoteDesktopResource';

/** Metadata survives tab/device switches; controller authority never lives in the resource. */
export default function RemoteDesktopResourceView({ resourceId, data, isActive }: {
  resourceId: string; data: RemoteDesktopResourceData; isActive: boolean;
}) {
  const service = useRemoteDesktopService();
  const { t } = useI18n('common');
  const close = () => { void useSceneStore.getState().closeScene(`content:${resourceId}`); };
  const registerRetirement = useCallback((retire: () => void) => registerContentCloseGuard(resourceId, async () => {
    // Closing a tab can await fallback session navigation. Retire its media and
    // input before that wait, independently of the eventual React unmount.
    retire(); return true;
  }), [resourceId]);
  useShortcut('tab.close', { key: 'w', ctrl: true, scope: 'canvas', allowInInput: true, allowInExclusiveInput: true }, close,
    { enabled: isActive, priority: 20, description: 'keyboard.shortcuts.tab.close' });
  if (!service) return <Alert tone="info" message={t('remoteDesktop.viewerPreparing')} />;
  if (!data?.device || typeof data.device.device_id !== 'string' || !service.connected
    || service.service_id !== data.serviceId || service.generation !== data.generation) {
    return <Alert tone="info" message={t('remoteDesktop.viewerIdentityChanged')} />;
  }
  return <RemoteDesktopViewer device={data.device} onClose={close} embedded isActive={isActive} registerRetirement={registerRetirement} />;
}
