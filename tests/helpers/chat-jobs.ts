import { randomUUID } from 'node:crypto';
import { AgentGitHubCredentialBroker } from '../../src/agents/credential-broker.js';
import { MemoryAgentJobAuthorizationStore, type AgentJobAuthorizationStore } from '../../src/agents/job-authorizations.js';
import { AgentRepositoryExecutor } from '../../src/agents/repository-executor.js';
import { MemoryAuthStore } from '../../src/auth/store.js';
import { createChatApp, type GitHubAppRuntime } from '../../src/chat/app.js';
import { OpenCodeChatProvider } from '../../src/chat/provider.js';
import { MemoryChatStore, type ChatStore } from '../../src/chat/store.js';
import { MemoryGitHubInstallationStore } from '../../src/github/installations.js';
import { MemoryConnectedRepositoryStore } from '../../src/github/repositories.js';
import type { CommandRunner } from '../../src/agents/process-runner.js';
import type { ChatExecutionRequest } from '../../src/chat/execution.js';

export async function chatJobsFixture(chats: ChatStore = new MemoryChatStore(), jobs: AgentJobAuthorizationStore = new MemoryAgentJobAuthorizationStore()) {
  const auth = new MemoryAuthStore(), installations = new MemoryGitHubInstallationStore(), repositories = new MemoryConnectedRepositoryStore();
  const alice = await auth.bindGitHubUser({ id: 1, login: 'alice' }), bob = await auth.bindGitHubUser({ id: 2, login: 'bob' });
  const session = await auth.createSession(alice.userId), other = await auth.createSession(bob.userId);
  await installations.linkInstallation(alice.userId, { installationId: 10, accountId: 1, accountLogin: 'alice', accountType: 'User', repositorySelection: 'selected', permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' } });
  await repositories.syncInstallation(alice.userId, 10, [1, 2].map(id => ({ repositoryId: id, fullName: `alice/${id === 1 ? 'app' : 'other'}`, defaultBranch: 'main', private: true, archived: false })));
  await repositories.setAgentEnabled(alice.userId, 1, true);
  const state = {
    decision: { repository: 'alice/app', instruction: 'Create a Next.js app', scaffold: { framework: 'nextjs', directory: '.' } } as ChatExecutionRequest | null,
    content: 'Requesting the change', prompts: [] as any[], opens: 0, edits: 0, prs: 0, cancels: 0,
    calls: [] as { command: string; args: string[]; cwd: string }[], failCheck: false, failSetup: 0, emptyHead: false,
    headGate: undefined as Promise<void> | undefined, editGate: undefined as Promise<void> | undefined,
  };
  const branches = new Map<string, string>();
  const commands: CommandRunner = { async run(command, args, options) {
    state.calls.push({ command, args, cwd: options.cwd });
    if (command === 'git' && args[0] === 'switch') branches.set(options.cwd, args[2]!);
    const stdout = command !== 'git' ? '' : args[0] === 'branch' ? branches.get(options.cwd) || '' : args[0] === 'remote' ? 'https://github.com/alice/app.git' : args[0] === 'rev-parse' ? 'b'.repeat(40) : args[0] === 'status' ? ' M src/app/page.tsx' : args[0] === 'diff' ? ' src/app/page.tsx | 1 +' : '';
    return { code: command === 'npm' && state.failCheck ? 1 : command === 'node' ? state.failSetup : 0, stdout, stderr: '' };
  } };
  const github = {
    async getRepositoryBranchHead() { await state.headGate; return state.emptyHead ? '' : 'a'.repeat(40); },
    async mintRepositoryCredential() { return { token: 'private-test-token', expiresAt: new Date(Date.now() + 3600000) }; },
    async createRepositoryPullRequest() { state.prs++; return { number: 42, url: 'https://github.com/alice/app/pull/42' }; },
  };
  const credentials = new AgentGitHubCredentialBroker(jobs, repositories, github);
  const agent = { async modify() { state.edits++; await state.editGate; } };
  const executor = new AgentRepositoryExecutor({ jobs, repositories, github, credentials, commands, agent,
    environment: { backend: 'daytona', async open(job) {
      state.opens++;
      const sandbox = { id: `sandbox-${job.jobId}`, name: `sandbox-${job.jobId}`, state: 'running' as const, updatedAt: new Date(), expiresAt: new Date(Date.now() + 3600000) };
      await jobs.updateExecution(job.jobId, job.userId, { sandbox });
      return { path: `/tmp/test/${job.jobId}/repo`, commands, agent,
        environment: async (_cwd, extra) => ({ CI: '1', ...extra }),
        readText: async () => JSON.stringify({ scripts: { check: 'tsc --noEmit', build: 'next build' } }),
        prepareChecks: async directory => { state.calls.push({ command: 'install', args: [], cwd: directory! }); return { command: 'npm install', ok: true }; },
        close: async (success, cancelled) => { await jobs.updateExecution(job.jobId, job.userId, { sandbox: { ...sandbox, state: success || cancelled ? 'deleted' : 'stopped' } }); },
      };
    }, async cancel(job) { state.cancels++; if (job.sandbox) await jobs.updateExecution(job.jobId, job.userId, { sandbox: { ...job.sandbox, state: 'deleted' } }); } },
  });
  const runtime: GitHubAppRuntime = { slug: 'journey', store: installations, repositoryStore: repositories, jobStore: jobs, repositoryExecutor: executor,
    verifier: { installationAuthorizationUrl: () => '', verifyInstallationCode: async () => ({ profile: { id: 1, login: 'alice' }, installations: [] }) } };
  const provider = new OpenCodeChatProvider({}, async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith('/message')) {
      state.prompts.push(await request.json());
      return Response.json({ info: { structured: { content: state.content, execution: state.decision } }, parts: [] });
    }
    return Response.json({ id: 'session-fixture' });
  });
  const makeApp = () => createChatApp(chats, provider, false, 3000, { store: auth, github: { authorizationUrl: () => '', exchangeCode: async () => ({ id: 1, login: 'alice' }) } }, undefined, runtime);
  let app = makeApp();
  const request = (path: string, body?: unknown, token = session.token) => app(new Request(`http://localhost:3000${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin: 'http://localhost:3000', cookie: `journey_session=${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const chat = await chats.create(alice.userId);
  return { state, auth, alice, other, session, chats, jobs, installations, repositories, runtime, executor, chat, request,
    send: (content = 'Build my app', requestId = randomUUID()) => request(`/api/chats/${chat.id}/messages`, { content, requestId }),
    handle: (request: Request) => app(request),
    restart() { app = makeApp(); return app; }, recover: () => app.recoverJobs(),
  };
}
export async function eventually<T>(fn: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await fn(); if (accept(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('State did not settle');
}
