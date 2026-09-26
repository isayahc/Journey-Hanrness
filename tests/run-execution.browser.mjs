import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { goalFixture } from './helpers/goal-execution.ts';

test('saved goal executes, preserves failed progress after reload, resumes, and awaits criteria evaluation', { timeout: 40_000 }, async () => {
  const f = await goalFixture(); f.state.failCheck = true;
  const browser = await chromium.launch();
  const errors = [];
  const timer = setInterval(() => { void f.recover().catch(error => errors.push(error.message)); }, 20);
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'journey_session', value: f.session.token, url: 'http://localhost:3000' }]);
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:3000/**', async route => {
      const request = route.request();
      const response = await f.handle(new Request(request.url(), { method: request.method(), headers: await request.allHeaders(), body: request.postData() || undefined }));
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.goto(`http://localhost:3000/goals?run=${f.run.id}`);
    await expect(page.getByRole('combobox', { name: 'Repository for this plan' })).toHaveValue('1');
    await page.getByRole('button', { name: 'Execute plan', exact: true }).click();
    await expect.poll(async () => ({ status: (await f.get())?.status, error: await page.locator('#run-error').textContent() }), { timeout: 10000 }).toEqual({ status: 'blocked', error: '' });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('#run-status')).toContainText('Execution blocked');
    await expect(page.locator('#plan-steps')).toContainText('FAIL: npm run check');
    await expect(page.locator('#plan-steps')).toContainText('Attempts: 1/2');
    const id = (await f.get()).execution.steps[0].jobId;
    f.restart(); await page.reload();
    await expect(page.locator('#execution-error')).toContainText('AGENT_CHECK_FAILED');
    f.state.failCheck = false;
    await page.getByRole('button', { name: 'Resume execution', exact: true }).click();
    await expect.poll(async () => (await f.get())?.status, { timeout: 10000 }).toBe('awaiting_evaluation');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('#run-status')).toContainText('Success criteria awaiting evaluation');
    await expect(page.locator('#plan-steps')).toContainText('Attempts: 2/2');
    await expect(page.locator('#plan-steps')).toContainText('PASS: npm run build');
    await expect(page.getByRole('link', { name: 'View step pull request' })).toHaveCount(3);
    assert.equal((await f.get()).execution.steps[0].jobId, id);
    assert.equal(f.state.edits, 2); assert.equal(f.state.prs, 2);
    await page.screenshot({ path: 'goal-plan-execution-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: 'goal-plan-execution-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    clearInterval(timer);
    try { if (page && !page.isClosed()) await page.unrouteAll({ behavior: 'wait' }); }
    finally { await browser.close(); }
  }
});
