import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { GitHubOAuth } from '../src/auth/github.ts';
import { MemoryAuthStore } from '../src/auth/store.ts';
import { createChatApp } from '../src/chat/app.ts';
import { DemoChatProvider } from '../src/chat/provider.ts';
import { MemoryChatStore } from '../src/chat/store.ts';
import { MemoryGitHubInstallationStore } from '../src/github/installations.ts';
import { MemoryConnectedRepositoryStore } from '../src/github/repositories.ts';

test('Sync recovers an already-installed GitHub App and returns to the repository list', { timeout: 30_000 }, async () => {
  const auth = new MemoryAuthStore();
  const identity = await auth.bindGitHubUser({ id: 100, login: 'alice' });
  const session = await auth.createSession(identity.userId);
  const installations = new MemoryGitHubInstallationStore();
  const repositories = new MemoryConnectedRepositoryStore();
  const githubFetch = async input => {
    const url = String(input);
    if (url.endsWith('/login/oauth/access_token')) return Response.json({ access_token: 'test-user-token' });
    if (url.endsWith('/user')) return Response.json({ id: 100, login: 'alice' });
    assert.match(url, /^https:\/\/api.github.com\/user\/installations\?/);
    return Response.json({ total_count: 1, installations: [{
      id: 42, app_slug: 'journey-harness', account: { id: 100, login: 'alice', type: 'User' },
      repository_selection: 'selected', permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' }, suspended_at: null,
    }] });
  };
  let app;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const response = await app(new Request(`${base}${req.url}`, {
        method: req.method, headers: req.headers, ...(body.length ? { body } : {}),
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const github = new GitHubOAuth('client', 'secret', `${base}/auth/github/callback`, githubFetch);
  app = createChatApp(new MemoryChatStore(), new DemoChatProvider(), true, server.address().port,
    { store: auth, github }, base, {
      slug: 'journey-harness', store: installations, verifier: github, repositoryStore: repositories,
      repositoryClient: { async listInstallationRepositories(id) {
        assert.equal(id, 42);
        return [{ repositoryId: 7, fullName: 'alice/project', private: true, archived: false, defaultBranch: 'main' }];
      } },
    });
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'journey_session', value: session.token, url: base, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let authorizations = 0;
    await page.route('https://github.com/login/oauth/authorize?*', async route => {
      authorizations++;
      const url = new URL(route.request().url());
      assert.equal(url.searchParams.get('redirect_uri'), `${base}/github/setup/callback`);
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', url.searchParams.get('state'));
      callback.searchParams.set('code', 'test-code');
      await route.fulfill({ status: 302, headers: { location: callback.toString() }, body: '' });
    });
    await page.goto(base);
    await page.getByRole('button', { name: 'Repositories', exact: true }).click();
    await page.getByText('No repositories are synced yet.', { exact: false }).waitFor();
    assert.equal(await page.locator('#connect-github').getAttribute('href'), '/github/connect');
    await page.getByRole('button', { name: 'Sync from GitHub' }).click();
    await page.getByText('alice/project', { exact: true }).waitFor();
    assert.equal(authorizations, 1);
    assert.equal(await page.locator('#connect-github').innerText(), 'GitHub · 1 installation');
    assert.equal((await repositories.listForUser(identity.userId))[0].agentEnabled, false);
    await page.getByRole('button', { name: 'Sync from GitHub' }).click();
    await page.getByText('Repository access refreshed from GitHub.', { exact: true }).waitFor();
    assert.equal(authorizations, 1, 'normal sync does not repeat authorization');
    await page.reload();
    await page.getByText('alice/project', { exact: true }).waitFor();
    await page.screenshot({ path: 'github-sync-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: 'github-sync-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
