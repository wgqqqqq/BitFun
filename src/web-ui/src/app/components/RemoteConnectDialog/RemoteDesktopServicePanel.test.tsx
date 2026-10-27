/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemoteDesktopServiceStatus } from '@/infrastructure/api/service-api/RemoteDesktopAPI';
import { RemoteDesktopServicePanel } from './RemoteDesktopServicePanel';

const mocks = vi.hoisted(() => ({
  status: null as RemoteDesktopServiceStatus | null, connect: vi.fn(), disconnect: vi.fn(), devices: vi.fn(), open: vi.fn(),
}));
vi.mock('@/infrastructure/account-identity', () => { throw new Error('Remote desktop pairing must not require account login'); });
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/infrastructure/remote-desktop/RemoteDesktopService', () => ({
  useRemoteDesktopService: () => mocks.status,
  remoteDesktopService: { connect: mocks.connect, disconnect: mocks.disconnect },
}));
vi.mock('@/infrastructure/api/service-api/RemoteDesktopAPI', () => ({ remoteDesktopAPI: { serviceDevices: mocks.devices } }));
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', () => ({ deviceDisplayName: (device: { device_name: string }) => device.device_name }));
vi.mock('./remoteDesktopResource', () => ({ openRemoteDesktopResource: mocks.open }));
vi.mock('./RemoteDesktopTrustSettings', () => ({ RemoteDesktopTrustSettings: () => <div>local-trust</div> }));
vi.mock('@openbitfun/ui', () => ({
  Alert: ({ message }: { message: string }) => <div>{message}</div>,
  StatusPill: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  OverflowText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Field: ({ label, children }: { label: string; children?: React.ReactNode }) => <label>{label}{children}</label>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Button: ({ loading: _loading, variant: _variant, leadingIcon: _leading, trailingIcon: _trailing, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; variant?: string; leadingIcon?: React.ReactNode; trailingIcon?: React.ReactNode }) => <button type="button" {...props} />,
}));
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.resetAllMocks();
  mocks.status = null; mocks.connect.mockResolvedValue(undefined); mocks.devices.mockResolvedValue([]);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function status(generation: string, connected = true): RemoteDesktopServiceStatus {
  return { generation, connected, service_url: 'https://desktop.example', service_id: 'service-a', device_id: 'local' };
}
async function render() { await act(async () => root.render(<RemoteDesktopServicePanel onClose={() => {}} />)); }
async function input(index: number, value: string) {
  await act(async () => {
    const node = container.querySelectorAll('input')[index];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('offers independent pairing while signed out, submits the secret only to enrollment and clears it on success', async () => {
  await render(); expect(container.querySelector('input[type=password]')).not.toBeNull();
  await input(0, ' https://desktop.example '); await input(1, 'private-pairing-key'); await input(2, 'My computer');
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(mocks.connect).toHaveBeenCalledWith('https://desktop.example', 'private-pairing-key', 'My computer');
  expect((container.querySelector('input[type=password]') as HTMLInputElement).value).toBe('');
  expect(mocks.devices).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled();
});
it('opens only another online desktop from the paired deployment', async () => {
  mocks.status = status('2');
  mocks.devices.mockResolvedValue([
    { device_id: 'local', device_name: 'This computer', device_kind: 'desktop', online: true },
    { device_id: 'phone', device_name: 'Phone', device_kind: 'mobile', online: true },
    { device_id: 'cli', device_name: 'CLI', device_kind: 'cli', online: true },
    { device_id: 'offline', device_name: 'Offline PC', device_kind: 'desktop', online: false },
    { device_id: 'peer', device_name: 'Other PC', device_kind: 'desktop', online: true },
  ]);
  await render();
  const buttons = [...container.querySelectorAll('button')].filter(node => node.textContent === 'remoteDesktop.viewerOpen');
  expect(buttons).toHaveLength(2); expect(buttons[0].disabled).toBe(false); expect(buttons[1].disabled).toBe(true);
  await act(async () => buttons[0].click());
  expect(mocks.open).toHaveBeenCalledWith('service-a', expect.objectContaining({ device_id: 'peer' }), 'remoteDesktop.viewerTabTitle');
  expect(container.textContent).toContain('local-trust');
});
it('discards a late device directory response after the service disconnects', async () => {
  let resolve!: (devices: unknown[]) => void;
  mocks.status = status('2'); mocks.devices.mockReturnValue(new Promise(done => { resolve = done; }));
  await render(); mocks.status = status('3', false); await render();
  await act(async () => resolve([{ device_id: 'old', device_name: 'Retired PC', online: true, device_kind: 'desktop' }]));
  expect(container.textContent).not.toContain('Retired PC'); expect(container.textContent).not.toContain('local-trust');
  expect(mocks.open).not.toHaveBeenCalled();
});

it('keeps service settings collapsed and explains how to add another computer', async () => {
  mocks.status = status('2'); await render();
  expect(container.querySelector('form')).toBeNull();
  expect(container.textContent).toContain('remoteDesktop.noComputers');
  expect(container.textContent).toContain('remoteDesktop.addComputerHint');
  const settings = [...container.querySelectorAll('button')].find(node => node.textContent === 'remoteDesktop.serviceSettings')!;
  expect(settings.getAttribute('aria-expanded')).toBe('false');
  await act(async () => settings.click());
  expect(settings.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('input[type=password]')).not.toBeNull();
  expect(container.textContent).toContain('remoteDesktop.disconnectHint');
  expect(mocks.disconnect).not.toHaveBeenCalled();
});
it('shows directory failures separately from pairing errors and allows a refresh', async () => {
  mocks.status = status('2'); mocks.devices.mockRejectedValueOnce(new Error('unavailable'));
  await render(); expect(container.textContent).toContain('remoteDesktop.directoryFailed');
  expect(container.textContent).toContain('remoteDesktop.directoryUnavailable');
  expect(container.textContent).not.toContain('remoteDesktop.serviceFailed');
  const refresh = [...container.querySelectorAll('button')].find(node => node.textContent === 'remoteDesktop.serviceRefresh')!;
  await act(async () => refresh.click());
  expect(container.textContent).not.toContain('remoteDesktop.directoryFailed');
  expect(container.textContent).toContain('remoteDesktop.noComputers');
});

it('discards endpoint and secret drafts when service settings are cancelled', async () => {
  mocks.status = status('2'); await render();
  const settings = [...container.querySelectorAll('button')].find(node => node.textContent === 'remoteDesktop.serviceSettings')!;
  await act(async () => settings.click());
  await input(0, 'https://discarded.example'); await input(1, 'discarded-secret');
  const cancel = [...container.querySelectorAll('button')].find(node => node.textContent === 'actions.cancel')!;
  await act(async () => cancel.click()); await act(async () => settings.click());
  expect((container.querySelectorAll('input')[0] as HTMLInputElement).value).toBe('https://desktop.example');
  expect((container.querySelector('input[type=password]') as HTMLInputElement).value).toBe('');
  expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.disconnect).not.toHaveBeenCalled();
});
