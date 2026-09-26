import { createChatApp } from '../../src/chat/app.js';
import { DemoChatProvider } from '../../src/chat/provider.js';
import { GoalExecutor } from '../../src/runs/executor.js';
import { RunService } from '../../src/runs/service.js';
import { MemoryRunStore, type RunStore } from '../../src/runs/store.js';
import { MemoryAgentJobAuthorizationStore, type AgentJobAuthorizationStore } from '../../src/agents/job-authorizations.js';
import type { Plan } from '../../src/runs/models.js';
import { chatJobsFixture } from './chat-jobs.js';

export const executionPlan: Plan = { summary: 'Implement, extend, and inspect the checks', steps: [
  { id: 'create', title: 'Create the app', instruction: 'Create the initial app files', dependsOn: [], verification: 'Build passes', execution: { kind: 'repository_change' } },
  { id: 'extend', title: 'Add a feature', instruction: 'Extend the app with a settings page', dependsOn: ['create'], verification: 'Check and build pass', execution: { kind: 'repository_change' } },
  { id: 'inspect', title: 'Inspect checks', instruction: 'Inspect recorded check results', dependsOn: ['extend'], verification: 'Check results are recorded', execution: { kind: 'inspect_checks' } },
] };
export async function goalFixture(store: RunStore = new MemoryRunStore(), jobs: AgentJobAuthorizationStore = new MemoryAgentJobAuthorizationStore()) {
  const f = await chatJobsFixture(undefined, jobs);
  await store.init(); await jobs.init();
  const service = new RunService(store, { plan: async () => executionPlan }, { OPENCODE_MODEL: 'saved/model' });
  const run = await service.create(f.alice.userId, { goal: 'Build my app', successCriteria: ['Settings page works'], limits: { maxAttemptsPerStep: 2 } });
  await service.plan(f.alice.userId, run.id);
  const worker = () => new GoalExecutor(store, f.runtime);
  let app = create();
  function create() { return createChatApp(f.chats, new DemoChatProvider(), false, 3000,
    { store: f.auth, github: { authorizationUrl: () => '', exchangeCode: async () => ({ id: 1, login: 'alice' }) } }, undefined, f.runtime, service); }
  return { ...f, store, service, run, worker,
    get: () => store.get(f.alice.userId, run.id),
    request: (path: string, body?: unknown, token = f.session.token) => app(new Request(`http://localhost:3000${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { origin: 'http://localhost:3000', cookie: `journey_session=${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })),
    handle: (request: Request) => app(request), recover: () => app.recoverJobs(), restart() { app = create(); },
  };
}
