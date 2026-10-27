// Execute the shipped WK bootstrap. This checks JS ordering, not native admission or OS input.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../src/apps/mobile/ios/OpenBitFun/Features/RemoteDesktop/RemoteDesktopReceiver.swift', import.meta.url), 'utf8');
const bootstrap = source.match(/let script = """([\s\S]*?)"""/)?.[1];
assert.ok(bootstrap, 'The native receiver must own its WK bootstrap');
function host(reply, accept = () => {}) {
  const window = { webkit: { messageHandlers: {
    remoteDesktopMedia: { postMessage() {} }, remoteDesktopControl: { postMessage: reply },
  } }, OpenBitFunDesktopReceiver: { accept } };
  vm.runInNewContext(bootstrap, { window });
  return window.OpenBitFunDesktopHost;
}

test('whole tap commands remain ordered across asynchronous native replies', async () => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const requests = [], accepted = [];
  const bridge = host(async ({ id, index }) => {
    requests.push(`${id}:${index}`);
    if (id === 'first' && index === 0) { entered(); await blocked; }
    return `${id}:${index}`;
  }, command => { accepted.push(command); });
  const first = bridge.runControl('first', 2), second = bridge.runControl('second', 2);
  await started; assert.deepEqual(requests, ['first:0']); release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(accepted, ['first:0', 'first:1', 'second:0', 'second:1']);
});

test('a refused old command cannot block a later valid release', async () => {
  const accepted = [];
  const bridge = host(async ({ id }) => id === 'old' ? false : 'release', value => { accepted.push(value); });
  assert.deepEqual(await Promise.all([bridge.runControl('old', 2), bridge.runControl('release', 1)]), [false, true]);
  assert.deepEqual(accepted, ['release']);
});

test('native reply failure prevents all later queued admissions', async () => {
  let requests = 0, accepted = 0;
  const bridge = host(async () => { requests++; throw new Error('fixture_reply_failure'); }, () => { accepted++; });
  const first = assert.rejects(bridge.runControl('first', 2), /fixture_reply_failure/);
  const second = bridge.runControl('second', 2);
  await first; assert.equal(await second, false);
  assert.equal(requests, 1); assert.equal(accepted, 0);
});

test('receiver failure stops the current command and poisons its queue', async () => {
  let requests = 0, accepted = 0;
  const bridge = host(async () => { requests++; return {}; }, () => { accepted++; throw new Error('fixture_receiver_failure'); });
  const first = assert.rejects(bridge.runControl('first', 2), /fixture_receiver_failure/);
  const second = bridge.runControl('second', 2);
  await first; assert.equal(await second, false);
  assert.equal(requests, 1); assert.equal(accepted, 1);
});
