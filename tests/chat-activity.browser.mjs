import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { activityFixture } from './helpers/chat-activity.ts';

test('live activity survives reload, stays in its chat, reconnects, stops, and preserves history', { timeout: 40_000 }, async () => {
  const f = await activityFixture(); let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(f.base);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect(composer).toBeEnabled(); await composer.fill('Check known security vulnerabilities'); await composer.press('Enter');
    await expect.poll(() => f.replies.has('Check known security vulnerabilities')).toBe(true);
    const first = f.replies.get('Check known security vulnerabilities');
    first.update({ id: 'search', label: 'Searching the web', status: 'running' });
    await expect(page.locator('#activity-current')).toHaveText('Searching the web');
    await expect(page.locator('#messages .message.user')).toHaveCount(1);
    first.update({ id: 'search', label: 'Searching the web', status: 'completed' });
    first.update({ id: 'page', label: 'Reading github.com', status: 'running' });
    await expect(page.locator('#activity-current')).toHaveText('Reading github.com');
    await expect(page.locator('#activity-recent')).toContainText('Done');
    await page.screenshot({ path: 'chat-composer-activity-desktop.png', fullPage: true });
    await page.reload();
    await expect(page.locator('#activity-current')).toHaveText('Reading github.com');
    await expect(page.getByRole('button', { name: 'Stop reply' })).toBeEnabled();
    await expect(page.getByRole('alert')).toBeHidden();
    await expect(page.locator('#messages .message.user')).toHaveCount(1);
    assert.equal(f.calls, 1, 'reload does not resubmit');
    let lost = false;
    await page.route('**/api/chats/*', async route => {
      if (!lost && route.request().method() === 'GET' && !route.request().url().endsWith('/jobs')) { lost = true; await route.abort(); }
      else await route.continue();
    });
    await expect(page.locator('#activity-current')).toContainText('Reconnecting');
    await expect(page.getByRole('button', { name: 'Stop reply' })).toBeEnabled();
    await expect(page.locator('#activity-current')).toHaveText('Reading github.com');
    assert.equal(first.options.signal.aborted, false);
    await page.getByRole('button', { name: 'New chat', exact: false }).click();
    await expect(page.locator('#thinking')).toBeHidden();
    await composer.fill('Unsent second chat');
    first.update({ id: 'page', label: 'Reading github.com', status: 'completed' }); first.finish();
    await expect(composer).toHaveValue('Unsent second chat');
    await expect(page.locator('#messages')).not.toContainText('github.com');
    await page.getByRole('button', { name: 'Check known security vulnerabilities', exact: true }).click();
    await expect(page.locator('#messages')).toContainText('Answer for Check known security vulnerabilities');
    await expect(page.locator('#thinking')).toBeHidden();
    await page.locator('.activity-history summary').click();
    await expect(page.locator('.activity-history')).toContainText('Reading github.com');
    await composer.fill('Another security question'); await composer.press('Enter');
    await expect.poll(() => f.replies.has('Another security question')).toBe(true);
    const second = f.replies.get('Another security question');
    second.update({ id: 'search', label: 'Searching the web', status: 'running' });
    await expect(page.locator('#activity-current')).toHaveText('Searching the web');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: 'chat-composer-activity-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Stop reply' }).click();
    await expect(composer).toBeEnabled(); await expect(page.locator('#thinking')).toBeHidden();
    await expect(page.getByRole('alert')).toContainText('Reply stopped');
    second.update({ id: 'late', label: 'Should never appear', status: 'running' });
    await expect(page.locator('body')).not.toContainText('Should never appear');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.close(); }
});
