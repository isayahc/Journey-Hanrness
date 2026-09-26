import { AgentRepositoryExecutor } from "../src/agents/repository-executor.js";
import { AgentGitHubCredentialBroker } from "../src/agents/credential-broker.js";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { EXECUTION_LEASE_MS, publicRun, type GoalRun } from '../src/runs/models.js';
import { GoalExecutor, executionProblem } from '../src/runs/executor.js';
import { MongoRunStore, type RunStore } from '../src/runs/store.js';
import { JOB_LEASE_MS, fencedJobStore, MemoryAgentJobAuthorizationStore, MongoAgentJobAuthorizationStore, type AgentJobAuthorization, type AgentJobAuthorizationStore } from '../src/agents/job-authorizations.js';
import { OpenCodeRepositoryAgent } from '../src/agents/opencode-repository-agent.js';
import { executionPlan, goalFixture } from './helpers/goal-execution.js';
import { eventually } from './helpers/chat-jobs.js';

async function finish(f: Awaited<ReturnType<typeof goalFixture>>) {
  return eventually(async () => { await f.worker().recover(); return f.get(); }, run => run?.status === 'awaiting_evaluation' || run?.status === 'blocked');
}

test('goal execution links dependent jobs to previous commits, survives fresh workers, and awaits evaluation', async () => {
  const f = await goalFixture();
  const first = await f.worker().start(f.alice.userId, f.run.id, { repositoryId: 1 });
  await f.worker().tick(f.alice.userId, f.run.id); // durable intent, no job exists yet
  const intent = (await f.get())!.execution!.steps[0]!;
  assert.ok(intent.jobId); assert.equal(await f.jobs.get(intent.jobId, f.alice.userId), null);
  await Promise.all([f.worker().recover(), f.worker().recover()]);
  const result = await finish(f);
  assert.equal(result?.status, 'awaiting_evaluation', JSON.stringify(result?.execution));
  assert.deepEqual(result.execution!.steps.map(step => step.status), ['succeeded', 'succeeded', 'succeeded']);
  assert.ok(result.execution!.steps.every(step => step.evaluation === 'pending'));
  const jobs = await f.jobs.listForUser(f.alice.userId);
  assert.equal(jobs.length, 2); assert.equal(f.state.edits, 2); assert.equal(f.state.prs, 2);
  const parent = jobs.find(job => job.jobId === intent.jobId)!;
  const child = jobs.find(job => job.parentJobId)!;
  assert.equal(child.parentJobId, parent.jobId); assert.equal(child.baseSha, parent.commitSha); assert.equal(child.defaultBranch, parent.branch);
  assert.ok(jobs.every(job => job.model === 'saved/model' && +job.deadlineAt! === +first.execution!.deadlineAt));
  assert.equal((await f.worker().start(f.alice.userId, f.run.id, { repositoryId: 1 })).status, 'awaiting_evaluation');
  await f.worker().recover(); assert.equal(f.state.prs, 2);
  assert.equal((await f.service.plan(f.alice.userId, f.run.id)).status, 'awaiting_evaluation');
});

test('goal start and resume enforce account, repository policy, payload bounds, and job access', async () => {
  const f = await goalFixture();
  const path = `/api/runs/${f.run.id}`;
  assert.equal((await f.request(`${path}/execute`, { repositoryId: 1 }, f.other.token)).status, 404);
  assert.equal((await f.request(`${path}/execute`, { repositoryId: 2 })).status, 403);
  assert.equal((await f.request(`${path}/execute`, { repositoryId: 1, model: 'bad/model' })).status, 400);
  assert.equal((await f.request(`${path}/execute`, { repositoryId: 1 })).status, 202);
  await finish(f);
  assert.equal((await f.request(`${path}/execute`, { repositoryId: 2 })).status, 409);
  const run = await (await f.request(path)).json();
  assert.equal('executionToken' in run, false); assert.equal('ownerId' in run, false);
  const jobs = await (await f.request('/api/agent-jobs')).json();
  assert.ok(jobs.every((job: any) => !('leaseToken' in job)));
  assert.equal((await f.request(`/api/agent-jobs/${jobs[0].jobId}/resume`, {})).status, 409);
  assert.equal((await f.request(`${path}/resume`, {}, f.other.token)).status, 404);
});

test('failed checks preserve intent and attempts; resume reuses edits and never resets the deadline', async () => {
  const f = await goalFixture(); f.state.failCheck = true;
  await f.worker().start(f.alice.userId, f.run.id, { repositoryId: 1 });
  const blocked = await finish(f);
  assert.equal(blocked?.status, 'blocked'); assert.equal(blocked.execution!.steps[0]!.error?.code, 'AGENT_CHECK_FAILED');
  assert.equal(blocked.execution!.steps[0]!.checkpoint, 'modified'); assert.equal(f.state.edits, 1);
  const id = blocked.execution!.steps[0]!.jobId;
  const deadline = +blocked.execution!.deadlineAt;
  await f.worker().resume(f.alice.userId, f.run.id);
  const exhausted = await finish(f);
  assert.equal(exhausted?.status, 'blocked'); assert.equal(exhausted.execution!.steps[0]!.attempts, 2);
  assert.equal(exhausted.execution!.steps[0]!.jobId, id); assert.equal(+exhausted.execution!.deadlineAt, deadline);
  assert.equal(f.state.edits, 1); assert.equal(f.state.prs, 0);
  await assert.rejects(f.worker().resume(f.alice.userId, f.run.id), /cannot resume/);
});

test('disabled repository access blocks with saved work', async () => {
  const f = await goalFixture();
  await f.worker().start(f.alice.userId, f.run.id, { repositoryId: 1 });
  await f.worker().tick(f.alice.userId, f.run.id);
  await f.repositories.setAgentEnabled(f.alice.userId, 1, false);
  await f.worker().tick(f.alice.userId, f.run.id);
  const run = await f.get(); assert.equal(run?.status, 'blocked');
  assert.ok(run.execution!.steps[0]!.jobId); assert.equal((await f.jobs.listForUser(f.alice.userId)).length, 0);
  assert.equal(f.state.edits, 0);
});

test('expired deadline cancels linked work and remains exhausted after restart', async () => {
  const f = await goalFixture(); let release!: () => void;
  f.state.editGate = new Promise(resolve => { release = resolve; });
  await f.worker().start(f.alice.userId, f.run.id, { repositoryId: 1 });
  await f.worker().recover(); await f.worker().recover();
  await eventually(async () => f.state.edits, value => value === 1);
  const run = (await f.get())!;
  const clock = () => new Date(+run.execution!.deadlineAt + 1);
  await new GoalExecutor(f.store, f.runtime, clock).recover(); release();
  assert.equal((await f.get())?.execution?.error?.code, 'TIME_LIMIT');
  assert.equal((await f.jobs.get(run.execution!.steps[0]!.jobId!, f.alice.userId))?.status, 'cancelled');
  await assert.rejects(new GoalExecutor(f.store, f.runtime, clock).resume(f.alice.userId, f.run.id), /cannot resume/);
});

test('unsupported and branched plans never dispatch work; narration cannot establish check evidence', async () => {
  assert.ok(executionProblem({ ...executionPlan, steps: [{ ...executionPlan.steps[0]!, execution: undefined }] }));
  assert.ok(executionProblem({ ...executionPlan, steps: [executionPlan.steps[0]!, { ...executionPlan.steps[1]!, dependsOn: [] }] }));
  const f = await goalFixture(); await f.worker().start(f.alice.userId, f.run.id, { repositoryId: 1 });
  await f.worker().recover();
  const run = (await f.get())!, step = run.execution!.steps[0]!;
  await f.jobs.create(step.jobId!, f.alice.userId, 1, { run: { id: run.id, stepId: step.id }, model: run.model });
  await f.jobs.updateExecution(step.jobId!, f.alice.userId, { summary: 'All criteria verified!', checks: [] });
  await f.jobs.setStatus(step.jobId!, f.alice.userId, 'completed');
  await f.worker().recover();
  const blocked = await f.get(); assert.equal(blocked?.status, 'blocked');
  assert.equal(blocked.execution!.steps[0]!.evaluation, 'pending'); assert.equal(blocked.execution!.error?.code, 'CHECK_EVIDENCE_REQUIRED');
  assert.equal(f.state.edits, 0);
});

async function verifyRunLeases(store?: RunStore, jobs?: AgentJobAuthorizationStore) {
  const f = await goalFixture(store, jobs);
  await f.worker().start(f.alice.userId, f.run.id, { repositoryId: 1 });
  const now = new Date();
  const claims = await Promise.all([f.store.claimExecution(f.alice.userId, f.run.id, now), f.store.claimExecution(f.alice.userId, f.run.id, now)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean)!;
  assert.equal(await f.store.claimExecution('another-owner', f.run.id, now), null);
  const renewAt = new Date(+now + EXECUTION_LEASE_MS - 1);
  assert.equal(await f.store.renewExecution(first, renewAt), true);
  assert.equal(await f.store.claimExecution(f.alice.userId, f.run.id, new Date(+now + EXECUTION_LEASE_MS + 1)), null);
  const later = new Date(+renewAt + EXECUTION_LEASE_MS + 1);
  const second = await f.store.claimExecution(f.alice.userId, f.run.id, later); assert.ok(second);
  assert.notEqual(second.executionToken, first.executionToken);
  assert.equal(await f.store.renewExecution(first, later), false);
  assert.equal(await f.store.saveExecution(first, first.execution!, 'awaiting_evaluation', later), false);
  const execution = structuredClone(second.execution!);
  execution.steps[0]!.jobId = randomUUID(); execution.steps[0]!.status = 'running'; execution.steps[0]!.attempts = 1;
  assert.equal(await f.store.saveExecution(second, execution, 'running', later), true);
  assert.equal('executionToken' in publicRun((await f.get())!), false);
  return f;
}
test('run leases renew, exclude competing owners/workers, and reject expired/stale completion', async () => { await verifyRunLeases(); });

async function verifyJobFences(jobs: AgentJobAuthorizationStore) {
  await jobs.init(); const id = randomUUID(); await jobs.create(id, 'owner', 1);
  const now = new Date();
  const claims = await Promise.all([jobs.claim(id, 'owner', new Date(+now + JOB_LEASE_MS), now), jobs.claim(id, 'owner', new Date(+now + JOB_LEASE_MS), now)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean)!;
  const scoped = fencedJobStore(jobs, first);
  await scoped.updateExecution(id, 'owner', { checkpoint: 'modified', leaseUntil: new Date(+now + JOB_LEASE_MS * 2) });
  assert.equal(await jobs.claim(id, 'owner', new Date(+now + JOB_LEASE_MS * 3), new Date(+now + JOB_LEASE_MS + 1)), null, 'renewal prevents early takeover');
  await jobs.updateExecution(id, 'owner', { leaseUntil: new Date(0) });
  await assert.rejects(scoped.updateExecution(id, 'owner', { checkpoint: 'completed' }), /AGENT_LEASE_LOST/);
  const second = await jobs.claim(id, 'owner', new Date(Date.now() + JOB_LEASE_MS)); assert.ok(second);
  await assert.rejects(scoped.setStatus(id, 'owner', 'completed'), /AGENT_LEASE_LOST/);
  await assert.rejects(scoped.updateExecution(id, 'owner', { leaseUntil: new Date(0), failure: 'STALE' }), /AGENT_LEASE_LOST/);
  assert.equal((await jobs.get(id, 'owner'))?.leaseToken, second.leaseToken);
  assert.equal((await jobs.get(id, 'owner'))?.checkpoint, 'modified');
  assert.equal(await scoped.authorizeCredentialJob('owner', id, 1), null);
}
test('repository job fencing rejects expired/stale writes and lease release', async () => { await verifyJobFences(new MemoryAgentJobAuthorizationStore()); });

test('MongoDB recovery survives reconnect with durable intent, duplicate delivery, and fenced workers', { skip: !process.env.MONGODB_TEST_URI }, async () => {
  const name = `journey_execution_${randomUUID().replaceAll('-', '')}`;
  let client = new MongoClient(process.env.MONGODB_TEST_URI!);
  try {
    await client.connect();
    const f = await verifyRunLeases(new MongoRunStore(client.db(name).collection<GoalRun>('runs')), new MongoAgentJobAuthorizationStore(client.db(name).collection<AgentJobAuthorization>('jobs')));
    const intent = (await f.get())!.execution!.steps[0]!.jobId;
    await eventually(async () => { await Promise.all([f.worker().recover(), f.worker().recover()]); return f.get(); }, run => run?.execution?.steps[0]?.status === 'succeeded');
    const saved = (await f.get())!;
    assert.equal(saved.execution!.steps[0]!.jobId, intent); assert.equal(f.state.edits, 1);
    await eventually(() => f.jobs.get(intent!, f.alice.userId), job => job?.leaseUntil?.getTime() === 0);
    await verifyJobFences(f.jobs);
    await client.close(); client = new MongoClient(process.env.MONGODB_TEST_URI!); await client.connect();
    const store = new MongoRunStore(client.db(name).collection<GoalRun>('runs'));
    const jobs = new MongoAgentJobAuthorizationStore(client.db(name).collection<AgentJobAuthorization>('jobs'));
    assert.equal((await store.get(f.alice.userId, f.run.id))?.execution?.steps[0]?.jobId, saved.execution!.steps[0]!.jobId);
    // New workers use reconnected stores; external service fixtures retain their independent state.
    const executor = new AgentRepositoryExecutor({ ...f.executionRuntime, jobs,
      credentials: new AgentGitHubCredentialBroker(jobs, f.repositories, f.github) });
    const runtime = { ...f.runtime, jobStore: jobs, repositoryExecutor: executor };
    for (let i = 0; i < 30; i++) {
      await Promise.all([new GoalExecutor(store, runtime).recover(), new GoalExecutor(store, runtime).recover()]);
      const run = await store.get(f.alice.userId, f.run.id);
      if (run?.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await store.get(f.alice.userId, f.run.id))?.status, 'awaiting_evaluation');
    assert.equal(f.state.edits, 2); assert.equal(f.state.prs, 2);
    assert.equal((await jobs.listForUser(f.alice.userId)).length, 2);
    assert.equal((await store.get(f.alice.userId, f.run.id))?.execution?.steps[0]?.jobId, saved.execution!.steps[0]!.jobId);
  } finally { await client.db(name).dropDatabase(); await client.close(); }
});

test('repository inference honors the saved model and deadline', async () => {
  const requests: any[] = [];
  const agent = new OpenCodeRepositoryAgent({ OPENCODE_MODEL: 'current/model' }, async (input, init) => {
    const request = new Request(input, init); requests.push(await request.json());
    return new URL(request.url).pathname.endsWith('/message') ? Response.json({ info: {}, parts: [] }) : Response.json({ id: 'session' });
  });
  await agent.modify('/tmp/repository', 'Edit files', { model: 'saved/model', deadlineAt: new Date(Date.now() + 5000) });
  assert.deepEqual(requests[1].model, { providerID: 'saved', modelID: 'model' });
  await assert.rejects(agent.modify('/tmp/repository', 'Edit files', { deadlineAt: new Date(0) }), /AGENT_DEADLINE_EXCEEDED/);
});


test('a replaced repository worker cannot publish, overwrite progress, or close the new workspace', async () => {
  const f = await goalFixture(); let release!: () => void;
  f.state.editGate = new Promise(resolve => { release = resolve; });
  const job = await f.executor.createJob({ userId: f.alice.userId, repositoryId: 1, instruction: 'Edit' });
  const active = f.executor.execute(job, 'Edit');
  await eventually(async () => f.state.edits, value => value === 1);
  await f.jobs.updateExecution(job.jobId, f.alice.userId, { leaseUntil: new Date(0) });
  const replacement = await f.jobs.claim(job.jobId, f.alice.userId, new Date(Date.now() + JOB_LEASE_MS));
  release(); await assert.rejects(active, /AGENT_LEASE_LOST/);
  const saved = await f.jobs.get(job.jobId, f.alice.userId);
  assert.equal(saved?.leaseToken, replacement?.leaseToken); assert.equal(saved?.status, 'running');
  assert.equal(saved?.checkpoint, 'workspace'); assert.equal(saved?.sandbox?.state, 'running');
  assert.equal(f.state.prs, 0); assert.ok(!f.state.calls.some(call => call.command === 'git' && call.args[0] === 'push'));
});

test('model failures persist a safe blocked state without losing the durable job ID', async () => {
  const f = await goalFixture();
  const environment = f.executionRuntime.environment!;
  const open = environment.open.bind(environment);
  environment.open = async (job, store) => { const session = await open(job, store); session.agent = { async modify() { throw new Error('provider private secret'); } }; return session; };
  await f.worker().start(f.alice.userId, f.run.id, { repositoryId: 1 });
  const run = await finish(f);
  assert.equal(run?.status, 'blocked'); assert.ok(run.execution!.steps[0]!.jobId);
  assert.equal(run.execution!.error?.code, 'AGENT_EXECUTION_FAILED');
  assert.doesNotMatch(JSON.stringify(run), /provider private secret/); assert.equal(f.state.prs, 0);
});


test('dependent jobs retain a scaffolded subdirectory and reject a changed parent branch', async () => {
  const f = await goalFixture();
  const parent = await f.executor.createJob({ userId: f.alice.userId, repositoryId: 1, instruction: 'Create app', model: 'saved/model',
    executionBackend: 'daytona', run: { id: f.run.id, stepId: 'create' }, scaffold: { framework: 'nextjs', directory: 'apps/web' } });
  await f.executor.execute(parent, parent.request!);
  const child = await f.executor.createJob({ userId: f.alice.userId, repositoryId: 1, instruction: 'Edit app', model: 'saved/model',
    executionBackend: 'daytona', run: { id: f.run.id, stepId: 'extend' }, parentJobId: parent.jobId });
  assert.equal(child.checkDirectory, 'apps/web');
  await f.executor.execute(child, child.request!);
  assert.ok(f.state.calls.filter(call => call.command === 'npm').every(call => call.cwd.endsWith('/apps/web')));
  f.github.getRepositoryBranchHead = async () => 'c'.repeat(40);
  await assert.rejects(f.executor.createJob({ userId: f.alice.userId, repositoryId: 1, instruction: 'Edit again',
    run: { id: f.run.id, stepId: 'later' }, parentJobId: parent.jobId }), /AGENT_RECOVERY_REQUIRES_RECONCILIATION/);
});
