import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useContentResourceStore } from '@/app/workbench/contentResourceStore';
import { openRemoteDesktopResource } from './remoteDesktopResource';

const service = vi.hoisted(() => ({ connected: true, service_id: 'service:a', generation: '1' }));
vi.mock('@/infrastructure/remote-desktop/RemoteDesktopService', () => ({ remoteDesktopService: { getSnapshot: () => service } }));
const device = { device_id: 'mac', device_name: 'Mac', device_kind: 'desktop', online: true, last_seen_at: null };
beforeEach(() => {
  service.connected = true; service.service_id = 'service:a'; activateSurface('local');
  useContentResourceStore.setState({ resources: {} });
  useSceneStore.setState({ openTabs: [], activeTabId: null, navHistory: [], navCursor: -1 });
});
afterEach(() => {
  useContentResourceStore.setState({ resources: {} });
  useSceneStore.setState({ openTabs: [], activeTabId: null }); activateSurface('local');
});
it('opens one service/target resource without workspace, SSH, credentials or a Peer switch', () => {
  activateSurface('peer');
  const id = openRemoteDesktopResource('service:a', device, 'Remote Mac');
  expect(getActiveSurfaceId()).toBe('peer');
  const resource = useContentResourceStore.getState().resources[id];
  expect(resource.scope).toEqual({ surfaceId: 'local' });
  expect(resource.content).toMatchObject({ type: 'remote-desktop', data: { serviceId: 'service:a', generation: '1', device: { device_id: 'mac' } } });
  expect(Object.keys(resource.content.data).sort()).toEqual(['device', 'generation', 'remoteConnectionId', 'serviceId', 'workspaceId', 'workspacePath']);
  expect(resource.content.data.workspaceId).toBeUndefined(); expect(resource.content.data.remoteConnectionId).toBeUndefined();
  expect(useSceneStore.getState().activeTabId).toBe(`content:${id}`);
  expect(openRemoteDesktopResource('service:a', device, 'Again')).toBe(id);
  expect(useSceneStore.getState().openTabs).toHaveLength(1);
  const other = openRemoteDesktopResource('service:a', { ...device, device_id: 'mac2' }, 'Second');
  expect(other).not.toBe(id);
  service.service_id = 'service:b'; expect(openRemoteDesktopResource('service:b', device, 'New service')).not.toBe(id);
});
it('keeps controller tabs independent while local and peer files retain their own saved tabs and drafts', () => {
  const store = useContentResourceStore.getState();
  const local = store.open({ type: 'code-editor', title: 'local', data: { filePath: '/local.ts' } }, { surfaceId: 'local', workspaceId: 'local-workspace' });
  useSceneStore.getState().openContentScene(local);
  const remote = openRemoteDesktopResource('service:a', device, 'Remote Mac');
  activateSurface('peer'); useSceneStore.getState().resetForPeerSwitch(true);
  expect(useSceneStore.getState().openTabs.map(tab => tab.contentId)).toEqual([remote]);
  expect(useSceneStore.getState().activeTabId).toBeNull();
  const peer = store.open({ type: 'code-editor', title: 'peer', data: { filePath: '/peer.ts' } }, { surfaceId: 'peer', workspaceId: 'peer-workspace' });
  store.update(peer, { isDirty: true }); useSceneStore.getState().openContentScene(peer);
  activateSurface('local'); useSceneStore.getState().resetForPeerSwitch(true);
  expect(useSceneStore.getState().openTabs.map(tab => tab.contentId)).toEqual([remote, local]);
  activateSurface('peer'); useSceneStore.getState().resetForPeerSwitch(true);
  expect(useSceneStore.getState().openTabs.map(tab => tab.contentId)).toEqual([remote, peer]);
  expect(useContentResourceStore.getState().resources[peer]).toMatchObject({ isDirty: true, scope: { surfaceId: 'peer' } });
  expect(useContentResourceStore.getState().resources[local].scope.surfaceId).toBe('local');
});
it('closes a remote resource through the existing tab gate without deleting other resources', async () => {
  const a = openRemoteDesktopResource('service:a', device, 'Remote Mac');
  const b = openRemoteDesktopResource('service:a', { ...device, device_id: 'other' }, 'Other');
  await useSceneStore.getState().closeScene(`content:${a}`);
  expect(useContentResourceStore.getState().resources[a]).toBeUndefined();
  expect(useContentResourceStore.getState().resources[b]).toBeDefined();
  expect(useSceneStore.getState().openTabs.map(tab => tab.contentId)).toEqual([b]);
});
it('rejects a stale service, disconnected deployment and unsupported/offline host before creating a tab', () => {
  expect(() => openRemoteDesktopResource('old', device, 'Old')).toThrow('controller_context_changed');
  service.connected = false; expect(() => openRemoteDesktopResource('service:a', device, 'Out')).toThrow('controller_context_changed');
  service.connected = true;
  for (const candidate of [{ ...device, online: false }, { ...device, device_kind: 'cli' }]) {
    expect(() => openRemoteDesktopResource('service:a', candidate, 'Invalid')).toThrow('unsupported');
  }
  expect(useSceneStore.getState().openTabs).toEqual([]); expect(useContentResourceStore.getState().resources).toEqual({});
});
