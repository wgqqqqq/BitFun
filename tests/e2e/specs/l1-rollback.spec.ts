/**
 * L1 rollback spec: validates rollback clears processing indicator.
 */

import { browser, expect } from '@wdio/globals';
import { ChatPage } from '../page-objects/ChatPage';
import { ChatInput } from '../page-objects/components/ChatInput';
import { Header } from '../page-objects/components/Header';
import { StartupPage } from '../page-objects/StartupPage';
import { saveScreenshot, saveFailureScreenshot } from '../helpers/screenshot-utils';
import { ensureWorkspaceOpen } from '../helpers/workspace-utils';

describe('L1 Rollback', () => {
  let chatPage: ChatPage;
  let chatInput: ChatInput;
  let header: Header;
  let startupPage: StartupPage;

  let hasWorkspace = false;

  before(async () => {
    console.log('[L1] Starting rollback tests');

    chatPage = new ChatPage();
    chatInput = new ChatInput();
    header = new Header();
    startupPage = new StartupPage();

    await browser.pause(3000);
    await header.waitForLoad();

    hasWorkspace = await ensureWorkspaceOpen(startupPage);

    if (!hasWorkspace) {
      console.log('[L1] No workspace available - tests will be skipped');
      return;
    }

    await chatPage.waitForLoad();
    await chatInput.waitForLoad();
  });

  it('rollback should clear processing indicator for the reverted turn', async function () {
    if (!hasWorkspace) {
      this.skip();
      return;
    }

    await chatInput.clear();

    const userCountBefore = await chatPage.getVisibleUserMessageCount();
    const prompt = `rollback-e2e-${Date.now()}`;

    await chatInput.typeMessage(prompt);
    await chatInput.clickSend();

    await browser.waitUntil(
      async () => (await chatPage.getVisibleUserMessageCount()) >= userCountBefore + 1,
      {
        timeout: 15000,
        timeoutMsg: 'User message did not appear after sending',
      }
    );

    await chatPage.waitForProcessingIndicatorVisible(15000);

    await browser.execute(() => {
      const originalConfirm = window.confirm;
      window.confirm = () => {
        window.confirm = originalConfirm;
        return true;
      };
    });

    await chatPage.clickLatestRollbackButton();

    await browser.waitUntil(
      async () => (await chatPage.getVisibleUserMessageCount()) === userCountBefore,
      {
        timeout: 15000,
        timeoutMsg: 'Rolled back user message still exists',
      }
    );

    await chatPage.waitForProcessingIndicatorHidden(15000);

    expect(await chatPage.hasVisibleProcessingIndicator()).toBe(false);
  });

  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await saveFailureScreenshot(`l1-rollback-${this.currentTest.title}`);
    }
  });

  after(async () => {
    await saveScreenshot('l1-rollback-complete');
    console.log('[L1] Rollback tests complete');
  });
});
