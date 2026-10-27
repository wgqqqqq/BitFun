import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ serviceStatus: vi.fn(), connectService: vi.fn(), disconnectService: vi.fn(), onServiceChanged: vi.fn() }));
vi.mock('../api/service-api/RemoteDesktopAPI', () => ({ remoteDesktopAPI: mocks }));
vi.mock('@/infrastructure/account-identity', () => { throw new Error('Self-hosted remote desktop must not read account login'); });
const status = (generation: string, connected = true) => ({ generation, connected,
  service_url: 'https://desktop.example', service_id: 'deployment-a', device_id: connected ? 'local-pc' : null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); mocks.onServiceChanged.mockReturnValue(() => {}); });

it('pairs without account login and keeps enrollment secrets out of the public service snapshot', async () => {
  const { remoteDesktopService } = await import('./RemoteDesktopService');
  mocks.connectService.mockResolvedValue(status('2'));
  await remoteDesktopService.connect('https://desktop.example', 'private-enrollment-key', 'My PC');
  expect(mocks.connectService).toHaveBeenCalledWith('https://desktop.example', 'private-enrollment-key', 'My PC');
  expect(remoteDesktopService.getSnapshot()).toEqual(status('2'));
  expect(JSON.stringify(remoteDesktopService.getSnapshot())).not.toContain('private-enrollment-key');
});

it('does not let a delayed connect or status read revive a disconnected service', async () => {
  const { remoteDesktopService } = await import('./RemoteDesktopService');
  const oldConnect = deferred<ReturnType<typeof status>>();
  mocks.connectService.mockReturnValue(oldConnect.promise);
  const pending = remoteDesktopService.connect('https://desktop.example', '', 'PC');
  mocks.disconnectService.mockResolvedValue(undefined);
  mocks.serviceStatus.mockResolvedValue(status('3', false));
  await remoteDesktopService.disconnect();
  oldConnect.resolve(status('2')); await pending;
  expect(remoteDesktopService.getSnapshot()).toEqual(status('3', false));
  const oldRead = deferred<ReturnType<typeof status>>();
  mocks.serviceStatus.mockReturnValueOnce(oldRead.promise);
  const reading = remoteDesktopService.refresh();
  mocks.connectService.mockResolvedValue(status('4'));
  await remoteDesktopService.connect('https://desktop.example', '', 'PC');
  oldRead.resolve(status('3', false)); await reading;
  expect(remoteDesktopService.getSnapshot()).toEqual(status('4'));
});

it('subscribes to the independent service lifecycle and only notifies on a changed snapshot', async () => {
  const { remoteDesktopService } = await import('./RemoteDesktopService');
  const listener = vi.fn(), stop = vi.fn();
  mocks.onServiceChanged.mockReturnValue(stop);
  const unsubscribe = remoteDesktopService.subscribe(listener);
  mocks.serviceStatus.mockResolvedValue(status('1'));
  await remoteDesktopService.refresh(); await remoteDesktopService.refresh();
  expect(listener).toHaveBeenCalledOnce();
  mocks.serviceStatus.mockResolvedValue(status('2', false));
  const changed = mocks.onServiceChanged.mock.calls[0][0];
  changed(); await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
  unsubscribe(); expect(stop).toHaveBeenCalledOnce();
});
