import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { chatJobsFixture } from './helpers/chat-jobs.ts';

test('chat job cards show persisted failure, resume, PR and cancellation without blocking another conversation', { timeout: 40_000 }, async () => {
  const f = await chatJobsFixture(); f.state.failCheck = true;
  const browser = await chromium.launch();
  let release;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'journey_session', value: f.session.token, url: 'http://localhost:3000' }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:3000/**', async route => {
      const request = route.request();
      const response = await f.handle(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postData() || undefined,
      }));
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.goto('http://localhost:3000');
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Create my app'); await composer.press('Enter');
    await expect(page.locator('#messages .agent-job-card')).toHaveCount(1);
    await expect(page.locator('#messages')).toContainText('Status: failed', { timeout: 10000 });
    await expect(page.locator('#messages')).toContainText('FAIL: npm run check');
    await expect(page.getByRole('button', { name: 'Stop reply' })).toBeHidden();
    await expect(composer).toBeEnabled();
    await page.reload();
    await expect(page.locator('#messages')).toContainText('Status: failed');
    f.state.failCheck = false;
    await page.getByRole('button', { name: 'Resume job', exact: true }).click();
    await expect(page.getByRole('link', { name: 'View pull request' })).toHaveAttribute('href', 'https://github.com/alice/app/pull/42', { timeout: 10000 });
    assert.equal(f.state.edits, 1); assert.equal(f.state.prs, 1);
    await page.screenshot({ path: 'chat-jobs-result.png', fullPage: true });
    await page.getByRole('button', { name: 'View repository jobs' }).click();
    await expect(page.locator('#agent-job-list')).toContainText('completed');
    await page.getByRole('button', { name: 'Back to chat', exact: false }).click();
    await expect(page.getByRole('link', { name: 'View pull request' })).toBeVisible();
    f.state.editGate = new Promise(resolve => { release = resolve; });
    await composer.fill('Another change'); await composer.press('Enter');
    await expect(page.locator('#messages .agent-job-card')).toHaveCount(2);
    await expect(page.locator('#messages')).toContainText('Status: running', { timeout: 10000 });
    await page.getByRole('button', { name: 'New chat', exact: false }).click();
    await expect(page.locator('#messages .agent-job-card')).toHaveCount(0);
    await composer.fill('My separate draft');
    await page.getByRole('button', { name: 'Create my app', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'chat-jobs-mobile.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: 'Cancel job', exact: true }).click(); release();
    await expect(page.locator('#messages')).toContainText('Status: cancelled', { timeout: 10000 });
    assert.equal(f.state.prs, 1);
    await page.reload();
    await expect(page.locator('#messages')).toContainText('Status: cancelled');
    assert.deepEqual(errors, []);
  } finally { release?.(); await browser.close(); }
});
