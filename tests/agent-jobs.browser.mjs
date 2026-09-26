import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

test('repository jobs submit, survive reload, show results, resume, cancel, and report errors', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let jobs = [];
    let failSubmit = false;
    const calls = [];
    await page.route('http://journey.test/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = data => route.fulfill({ json: data });
      if (path === '/api/status') return json({ authEnabled: true, githubAppEnabled: true, githubRepoSyncEnabled: true, agentJobsEnabled: true });
      if (path === '/api/me') return json({ githubLogin: 'alice' });
      if (path === '/api/github/installations' || path === '/api/chats') return json([]);
      if (path === '/api/github/repositories') return json([
        { repositoryId: 1, fullName: 'alice/enabled', agentEnabled: true },
        { repositoryId: 2, fullName: 'alice/disabled', agentEnabled: false },
        { repositoryId: 3, fullName: 'alice/archived', agentEnabled: true, archived: true },
      ]);
      if (path === '/api/agent-jobs' && request.method() === 'POST') {
        calls.push(request.postDataJSON());
        if (failSubmit) return route.fulfill({ status: 403, json: { error: 'Repository is not authorized for agent work.' } });
        jobs = [{ jobId: '12345678-1234-1234-1234-123456789012', repositoryId: 1, repositoryFullName: 'alice/enabled', request: request.postDataJSON().instruction, status: 'running', checkpoint: 'workspace', leaseUntil: new Date(Date.now() + 60000).toISOString() }];
        return json(jobs[0]);
      }
      if (path === '/api/agent-jobs') return json(jobs);
      if (path.endsWith('/resume')) { jobs[0].status = 'running'; jobs[0].leaseUntil = new Date(Date.now() + 60000).toISOString(); return json({ status: 'resuming' }); }
      if (path.endsWith('/cancel')) { jobs[0].status = 'cancelled'; return json(jobs[0]); }
      const file = path === '/' ? 'index.html' : path.slice(1);
      return route.fulfill({ body: await readFile(new URL(`../public/${file}`, import.meta.url)), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    const open = async () => {
      await page.goto('http://journey.test/');
      await page.getByRole('button', { name: 'Repositories', exact: true }).click();
      await expect(page.locator('#agent-repository option')).toHaveCount(1);
    };
    await open();
    await page.locator('#agent-instruction').fill('Add tests <script>bad()</script>');
    await page.getByRole('button', { name: 'Start agent job' }).click();
    await expect(page.locator('#agent-job-list')).toContainText('Status: running');
    assert.deepEqual(calls, [{ repositoryId: 1, instruction: 'Add tests <script>bad()</script>' }]);
    await expect(page.getByRole('button', { name: 'Resume job' })).toHaveCount(0);
    await open();
    await expect(page.locator('#agent-job-list')).toContainText('Add tests');
    jobs[0] = { ...jobs[0], status: 'failed', leaseUntil: null, checkpoint: 'modified', failure: 'CHECKS_FAILED', summary: 'Updated tests', checks: [{ command: 'npm test', ok: false }] };
    await page.getByRole('button', { name: 'Refresh jobs' }).click();
    await expect(page.locator('#agent-job-list')).toContainText('FAIL: npm test');
    await expect(page.locator('#agent-job-list')).toContainText('Failure: CHECKS_FAILED');
    await page.getByRole('button', { name: 'Resume job' }).click();
    await expect(page.locator('#agent-job-list')).toContainText('Status: running');
    await page.getByRole('button', { name: 'Cancel job' }).click();
    await expect(page.locator('#agent-job-list')).toContainText('Status: cancelled');
    await expect(page.getByRole('button', { name: 'Cancel job' })).toHaveCount(0);
    jobs[0] = { ...jobs[0], status: 'completed', checkpoint: 'completed', failure: null, pullRequestUrl: 'https://github.com/alice/enabled/pull/7', checks: [{ command: 'npm test', ok: true }] };
    await page.getByRole('button', { name: 'Refresh jobs' }).click();
    await expect(page.getByRole('link', { name: 'View pull request' })).toHaveAttribute('href', jobs[0].pullRequestUrl);
    failSubmit = true;
    await page.locator('#agent-instruction').fill('Keep this on failure');
    await page.getByRole('button', { name: 'Start agent job' }).click();
    await expect(page.locator('#agent-job-error')).toContainText('not authorized');
    await expect(page.locator('#agent-instruction')).toHaveValue('Keep this on failure');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
