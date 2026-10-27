/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteDesktopTrustSettings } from './RemoteDesktopTrustSettings';
import type { RemoteDesktopLocalSettings } from '@/infrastructure/api/service-api/RemoteDesktopAPI';

const calls = vi.hoisted(() => ({ settings: vi.fn(), approveView: vi.fn(), approveControl: vi.fn(), revokeView: vi.fn(), stop: vi.fn(), captureConsent: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/RemoteDesktopAPI', () => ({ remoteDesktopAPI: calls }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, formatNumber: String }) }));
vi.mock('@openbitfun/ui', () => ({
  Alert: ({ message }: { message: string }) => <p>{message}</p>,
  OverflowText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Field: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Button: ({ children, onClick, disabled }: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{children}</button>,
  Select: ({ options, value, onValueChange, disabled, 'aria-label': label }: { options: Array<{ value: string; label: string }>; value: string; onValueChange: (value: string) => void; disabled?: boolean; 'aria-label': string }) => <select aria-label={label} value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}><option value="" />{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>,
}));
const snapshot: RemoteDesktopLocalSettings = {
  displays: [{ display_id: 'screen', width: 1280, height: 800 }], grants: [],
  availability: 'media_backend_unavailable', storage_available: true, state_revision: 'boot:0',
};
const devices = [
  { device_id: 'local', device_name: 'This computer', online: true },
  { device_id: 'phone', device_name: 'Phone', device_kind: 'mobile', online: true },
];
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.resetAllMocks();
  calls.settings.mockResolvedValue(snapshot); calls.approveView.mockResolvedValue(undefined);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const click = async (key: string) => act(async () => {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === `remoteDesktop.${key}`)!;
  button.click();
});
const render = async (key = 'account') => act(async () => { root.render(<RemoteDesktopTrustSettings key={key} devices={devices} localDeviceId="local" />); });
const select = async (name: string, value: string) => act(async () => {
  const input = host.querySelector<HTMLSelectElement>(`select[aria-label="remoteDesktop.${name}"]`)!;
  input.value = value; input.dispatchEvent(new Event('change', { bubbles: true }));
});

it('keeps local stop available before access is opened or loaded', async () => {
  calls.stop.mockResolvedValue(undefined);
  await render();
  expect(host.textContent).toContain('remoteDesktop.stop');
  await click('stop');
  expect(calls.stop).toHaveBeenCalledOnce(); expect(calls.settings).not.toHaveBeenCalled();
});

it('stops while the initial settings read is pending and ignores its late snapshot', async () => {
  let finish!: (settings: RemoteDesktopLocalSettings) => void;
  calls.settings.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  calls.stop.mockResolvedValue(undefined);
  await render(); await click('manage'); await click('stop');
  expect(calls.stop).toHaveBeenCalledOnce();
  expect(calls.settings).toHaveBeenCalledTimes(2);
  await act(async () => finish({ ...snapshot, grants: [{ account_id: 'account', device_id: 'retired-snapshot', public_key_fingerprint: 'a'.repeat(64), display_ids: ['screen'] }] }));
  expect(host.textContent).not.toContain('retired-snapshot');
});

it('stops without waiting for a pending authorization and does not reload its late result', async () => {
  let finish!: () => void;
  calls.approveView.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  calls.stop.mockResolvedValue(undefined);
  await render(); await click('manage'); await select('controller', 'phone'); await select('display', 'screen');
  await click('allowView'); await click('stop');
  expect(calls.stop).toHaveBeenCalledOnce(); expect(calls.settings).toHaveBeenCalledTimes(2);
  await act(async () => finish());
  expect(calls.settings).toHaveBeenCalledTimes(2);
});

it('shows a local stop failure while collapsed and permits an explicit retry', async () => {
  calls.stop.mockRejectedValueOnce(new Error('local stop unavailable')).mockResolvedValue(undefined);
  await render(); await click('stop');
  expect(host.textContent).toContain('remoteDesktop.stopFailed');
  await click('stop');
  expect(calls.stop).toHaveBeenCalledTimes(2); expect(host.textContent).not.toContain('remoteDesktop.stopFailed');
});

it('does not duplicate a pending stop or publish its error into a new account', async () => {
  let reject!: (error: Error) => void;
  calls.stop.mockReturnValueOnce(new Promise<void>((_resolve, fail) => { reject = fail; }));
  await render(); await click('stop'); await click('stop');
  expect(calls.stop).toHaveBeenCalledOnce();
  await render('new-account'); await act(async () => reject(new Error('old account stop failed')));
  expect(host.textContent).not.toContain('remoteDesktop.stopFailed');
});

it('requires an explicit device and display before opening native authorization', async () => {
  await render(); expect(calls.settings).not.toHaveBeenCalled(); await click('manage');
  expect(host.textContent).toContain('remoteDesktop.mediaPending');
  expect(host.querySelector('option[value="local"]')).toBeNull();
  const allow = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'remoteDesktop.allowView')!;
  expect(allow().disabled).toBe(true); await select('controller', 'phone'); expect(allow().disabled).toBe(true);
  await select('display', 'screen'); expect(allow().disabled).toBe(false); expect(calls.approveView).not.toHaveBeenCalled();
  await click('allowView'); expect(calls.approveView).toHaveBeenCalledExactlyOnceWith('phone', 'screen');
});

it('uses the controller directory even when the normal peer list contains only this computer', async () => {
  calls.settings.mockResolvedValue({ ...snapshot, controller_directory_state: 'ready', controller_devices: [
    { device_id: 'phone', device_name: 'Phone', device_alias: 'My phone', device_kind: 'mobile' },
  ] });
  await act(async () => root.render(<RemoteDesktopTrustSettings devices={[devices[0]]} localDeviceId="local" />));
  await click('manage');
  expect(host.querySelector('option[value="phone"]')?.textContent).toBe('My phone');
  await select('controller', 'phone'); await select('display', 'screen');
  expect(calls.approveView).not.toHaveBeenCalled();
  await click('allowView');
  expect(calls.approveView).toHaveBeenCalledExactlyOnceWith('phone', 'screen');
});

it('keeps local stop and revocation available when controller discovery fails', async () => {
  calls.settings.mockResolvedValue({ ...snapshot, controller_directory_state: 'unavailable', controller_devices: [],
    grants: [{account_id:'account',device_id:'phone',public_key_fingerprint:'a'.repeat(64),display_ids:['screen']}] });
  await render(); await click('manage');
  expect(host.textContent).toContain('remoteDesktop.controllerDirectoryFailed');
  expect(host.querySelector('option[value="phone"]')).toBeNull();
  await select('display', 'screen'); await click('allowView');
  expect(calls.approveView).not.toHaveBeenCalled();
  await click('stop'); expect(calls.stop).toHaveBeenCalledTimes(1);
  await click('revoke'); expect(calls.revokeView).toHaveBeenCalledExactlyOnceWith('phone');
});

it('explains a Relay upgrade instead of treating an unsupported directory as empty', async () => {
  calls.settings.mockResolvedValue({ ...snapshot, controller_directory_state: 'unsupported', controller_devices: [] });
  await render(); await click('manage');
  expect(host.textContent).toContain('remoteDesktop.controllerDirectoryUpgrade');
});

it('gates control preauthorization on the local capability and never upgrades a viewing click', async () => {
  await render(); await click('manage');
  expect(host.textContent).not.toContain('remoteDesktop.allowControl');
  calls.settings.mockResolvedValue({ ...snapshot, control_grant_supported: true, control_available: false });
  await click('refresh');
  expect(host.textContent).toContain('remoteDesktop.controlPending');
  await select('controller', 'phone'); await select('display', 'screen');
  await click('allowView');
  expect(calls.approveControl).not.toHaveBeenCalled();
  await click('allowControl');
  expect(calls.approveControl).toHaveBeenCalledExactlyOnceWith('phone', 'screen');
  expect(calls.approveView).toHaveBeenCalledTimes(1);
});

it('shows stored control scope separately from a legacy viewing grant', async () => {
  calls.settings.mockResolvedValue({ ...snapshot, grants: [
    { account_id: 'account', device_id: 'phone', public_key_fingerprint: 'a'.repeat(64), display_ids: ['screen'] },
    { account_id: 'account', device_id: 'desktop', public_key_fingerprint: 'b'.repeat(64), display_ids: ['screen'], control_display_ids: ['screen'] },
  ] });
  await render(); await click('manage');
  expect(host.textContent).toContain('remoteDesktop.viewAccess');
  expect(host.textContent).toContain('remoteDesktop.controlAccess');
});

it('drops a late grant snapshot after closing or changing the account owner', async () => {
  let finish!: (settings: RemoteDesktopLocalSettings) => void;
  calls.settings.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await render(); await click('manage'); await click('close'); await render('new-account');
  await act(async () => { finish({ ...snapshot, grants: [{ account_id: 'old', device_id: 'old-device', public_key_fingerprint: 'a'.repeat(64), display_ids: ['screen'] }] }); });
  expect(host.textContent).not.toContain('old-device'); expect(host.querySelector('select')).toBeNull();
  await click('manage'); expect(host.textContent).toContain('remoteDesktop.noGrants');
});

it('retains the error state and disables approval when the native grant file is unavailable', async () => {
  calls.settings.mockResolvedValue({ ...snapshot, storage_available: false });
  await render(); await click('manage'); await select('controller', 'phone'); await select('display', 'screen');
  expect(host.textContent).toContain('remoteDesktop.storageUnavailable'); await click('allowView');
  expect(calls.approveView).not.toHaveBeenCalled();
});

it('reports an unsupported platform without offering grant or input actions', async () => {
  calls.settings.mockResolvedValue({ ...snapshot, availability: 'unsupported', displays: [] });
  await render(); await click('manage');
  expect(host.textContent).toContain('remoteDesktop.unsupported');
  expect(host.querySelector('select')).toBeNull();
  expect(host.textContent).not.toContain('remoteDesktop.allowView');
  expect(calls.approveView).not.toHaveBeenCalled();
});

it('requests only local OS consent explicitly and keeps device authorization separate', async () => {
  calls.settings.mockResolvedValue({ ...snapshot, availability: 'permission_required' });
  calls.captureConsent.mockResolvedValue({ current_granted: false });
  await render(); await click('manage');
  expect(host.textContent).toContain('remoteDesktop.capturePermissionRequired');
  expect(calls.captureConsent).not.toHaveBeenCalled();
  await click('requestCapturePermission');
  expect(calls.captureConsent).toHaveBeenCalledExactlyOnceWith('request');
  expect(calls.approveView).not.toHaveBeenCalled();
  await click('openCaptureSettings');
  expect(calls.captureConsent).toHaveBeenLastCalledWith('open_settings');
  expect(calls.approveView).not.toHaveBeenCalled();
});
