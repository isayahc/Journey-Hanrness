import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryAuthStore } from '../src/auth/store.js';
import { MemoryGitHubInstallationStore } from '../src/github/installations.js';
import { MemoryConnectedRepositoryStore } from '../src/github/repositories.js';
import { createChatApp } from '../src/chat/app.js';
import { MemoryChatStore } from '../src/chat/store.js';
import { OpenCodeChatProvider } from '../src/chat/provider.js';

test('chat receives only the current user’s active, synced repositories and refreshes them each turn', async () => {
  const auth = new MemoryAuthStore(), installations = new MemoryGitHubInstallationStore(), repositories = new MemoryConnectedRepositoryStore();
  const alice = await auth.bindGitHubUser({ id: 1, login: 'alice' });
  const bob = await auth.bindGitHubUser({ id: 2, login: 'bob' });
  const session = await auth.createSession(alice.userId);
  for (const [userId, installationId] of [[alice.userId, 10], [bob.userId, 20]] as const) {
    await installations.linkInstallation(userId, { installationId, accountId: installationId, accountLogin: 'test', accountType: 'User', repositorySelection: 'selected', permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' } });
  }
  const repo = (repositoryId: number, fullName: string, archived = false) => ({ repositoryId, fullName, defaultBranch: 'main', private: true, archived });
  await repositories.syncInstallation(alice.userId, 10, [repo(1, 'alice/enabled'), repo(2, 'alice/disabled'), repo(3, 'alice/archive', true)]);
  await repositories.setAgentEnabled(alice.userId, 1, true);
  await repositories.syncInstallation(bob.userId, 20, [repo(4, 'bob/private')]);
  // A stale repository row whose installation is not active must not be exposed.
  await repositories.syncInstallation(alice.userId, 99, [repo(5, 'alice/stale')]);
  const prompts: any[] = [];
  const provider = new OpenCodeChatProvider({}, async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith('/message')) {
      prompts.push(await request.json());
      return Response.json({ info: { structured: { content: 'Repository summary', execution: null } }, parts: [] });
    }
    return Response.json({ id: 'owner-session' });
  });
  const app = createChatApp(new MemoryChatStore(), provider, false, 3000, {
    store: auth, github: { authorizationUrl: () => '', exchangeCode: async () => ({ id: 1, login: 'alice' }) },
  }, undefined, {
    slug: 'journey-harness', store: installations, repositoryStore: repositories,
    verifier: { installationAuthorizationUrl: () => '', verifyInstallationCode: async () => ({ profile: { id: 1, login: 'alice' }, installations: [] }) },
  });
  const request = (path: string, body: unknown) => app(new Request(`http://localhost:3000${path}`, {
    method: 'POST', headers: { origin: 'http://localhost:3000', cookie: `journey_session=${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  const chat = await (await request('/api/chats', {})).json();
  assert.equal((await request(`/api/chats/${chat.id}/messages`, { content: 'Which repositories?', github: { repositories: ['bob/private'] } })).status, 400);
  assert.equal((await request(`/api/chats/${chat.id}/messages`, { content: 'Which repositories?' })).status, 200);
  const context = JSON.parse(prompts[0].parts[0].text).github;
  assert.equal(context.status, 'connected');
  assert.equal(context.total, 3);
  assert.deepEqual(context.repositories.map((entry: any) => entry.fullName).sort(), ['alice/archive', 'alice/disabled', 'alice/enabled']);
  assert.equal(context.repositories.find((entry: any) => entry.fullName === 'alice/enabled').agentEnabled, true);
  assert.equal(context.repositories.find((entry: any) => entry.fullName === 'alice/disabled').agentEnabled, false);
  assert.doesNotMatch(JSON.stringify(context), /bob\/private|alice\/stale|connectedByUserId|installationId|token/);
  await repositories.syncInstallation(alice.userId, 10, [repo(2, 'alice/disabled')]);
  assert.equal((await request(`/api/chats/${chat.id}/messages`, { content: 'And now?' })).status, 200);
  const updated = JSON.parse(prompts[1].parts[0].text).github;
  assert.equal(updated.total, 1);
  assert.equal(updated.repositories[0].fullName, 'alice/disabled');
  await installations.setInstallationState(10, 'suspended');
  assert.equal((await request(`/api/chats/${chat.id}/messages`, { content: 'Still connected?' })).status, 200);
  assert.deepEqual(JSON.parse(prompts[2].parts[0].text).github, { status: 'not_connected', total: 0, truncated: false, repositories: [] });
});
