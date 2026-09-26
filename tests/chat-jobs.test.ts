import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ChatJobService } from '../src/chat/jobs.js';
import { chatJobsFixture, eventually } from './helpers/chat-jobs.js';

const saved = async (f: Awaited<ReturnType<typeof chatJobsFixture>>) => (await f.request(`/api/chats/${f.chat.id}`)).json();

test('chat structured handoff scaffolds once, persists checks/PR and replays an HTTP retry after restart', async () => {
  const f = await chatJobsFixture();
  const id = randomUUID();
  const response = await f.send('Build my app', id);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.messages[1].requestId, id);
  assert.match(receipt.messages[1].content, /Job requested/);
  const jobId = receipt.messages[1].job.jobId;
  const job = await eventually(() => f.jobs.get(jobId, f.alice.userId), job => job?.status === 'completed');
  assert.equal(job?.chat?.id, f.chat.id);
  assert.equal(job?.chat?.requestId, id);
  assert.equal(job?.executionBackend, 'daytona');
  assert.equal(job?.sandbox?.state, 'deleted');
  assert.equal(job?.pullRequestUrl, 'https://github.com/alice/app/pull/42');
  assert.deepEqual(job?.checks?.map(check => check.command), ['npm install', 'npm run check', 'npm run build']);
  assert.equal(f.state.calls.filter(call => call.command === 'node').length, 1);
  assert.equal(f.state.opens, 1); assert.equal(f.state.prs, 1);
  assert.doesNotMatch(JSON.stringify(await saved(f)), /private-test-token/);
  f.restart(); await f.recover();
  assert.equal((await f.send('Build my app', id)).status, 200);
  assert.equal(f.state.prompts.length, 1);
  assert.equal(f.state.opens, 1); assert.equal(f.state.prs, 1);
  assert.equal((await saved(f)).messages.length, 2);
  assert.equal((await saved(f)).jobs[0].status, 'completed');
  assert.equal((await f.send('Different request', id)).status, 409);
  assert.equal((await f.request(`/api/chats/${f.chat.id}/jobs`, undefined, f.other.token)).status, 404);
  assert.equal((await f.request(`/api/agent-jobs/${jobId}/cancel`, {}, f.other.token)).status, 404);
});

test('ordinary discussion and ambiguous-target clarification do not provision; existing-app edits omit scaffolding', async () => {
  const f = await chatJobsFixture();
  await f.repositories.setAgentEnabled(f.alice.userId, 2, true);
  f.state.decision = null; f.state.content = 'Which repository should I change: alice/app or alice/other?';
  await f.send('Build an app');
  assert.equal(f.state.opens, 0); assert.equal((await saved(f)).jobs.length, 0);
  const prompt = f.state.prompts[0];
  assert.equal(prompt.format.type, 'json_schema');
  assert.match(prompt.system, /ambiguous/); assert.match(prompt.system, /discussion/);
  assert.equal(JSON.parse(prompt.parts[0].text).github.repositories.length, 2);
  f.state.decision = { repository: 'alice/app', instruction: 'Change the existing app heading', scaffold: null };
  await f.send('In alice/app, change the heading');
  await eventually(() => f.jobs.listForUser(f.alice.userId), jobs => jobs[0]?.status === 'completed');
  assert.equal(f.state.edits, 1); assert.equal(f.state.calls.some(call => call.command === 'node'), false);
});

test('server rejects model-selected inaccessible, disabled, disconnected, suspended and policy-denied targets', async () => {
  for (const scenario of ['inaccessible', 'disabled', 'disconnected', 'suspended', 'policy', 'forged-owner'] as const) {
    const f = await chatJobsFixture();
    if (scenario === 'inaccessible') f.state.decision!.repository = 'bob/private';
    if (scenario === 'disabled') await f.repositories.setAgentEnabled(f.alice.userId, 1, false);
    if (scenario === 'disconnected') await f.repositories.syncInstallation(f.alice.userId, 10, []);
    if (scenario === 'suspended') await f.installations.setInstallationState(10, 'suspended');
    if (scenario === 'policy') f.repositories.authorizeAgentRepositoryAction = async () => null;
    if (scenario === 'forged-owner') Object.assign(f.state.decision!, { userId: f.other.token });
    const response = await f.send();
    assert.equal(response.status, scenario === 'forged-owner' ? 502 : 200);
    if (response.status === 200) assert.match((await response.json()).messages[1].content, /access|policy/i);
    assert.equal(f.state.opens, 0); assert.equal((await f.jobs.listForUser(f.alice.userId)).length, 0);
  }
});

test('missing Daytona never falls back to the host; an empty repository is initialized before execution', async () => {
  const f = await chatJobsFixture();
  const executor = f.runtime.repositoryExecutor;
  f.runtime.repositoryExecutor = undefined;
  await f.send();
  assert.match((await saved(f)).messages[1].content, /Daytona/);
  assert.equal(JSON.parse(f.state.prompts[0].parts[0].text).execution.enabled, false);
  assert.equal(f.state.opens, 0);
  f.runtime.repositoryExecutor = executor; f.state.emptyHead = true;
  await f.send('Try again');
  const chat = await eventually(() => saved(f), chat => chat.jobs[0]?.status === 'completed');
  assert.equal(chat.jobs[0].failure, undefined);
  assert.equal(f.state.opens, 1);
});

test('durable outbox survives a crash before dispatch and concurrent recovery creates exactly one job', async () => {
  const f = await chatJobsFixture();
  const service = new ChatJobService(f.chats, f.runtime);
  const link = await service.prepare(f.alice.userId, f.state.decision!);
  const id = randomUUID();
  await f.chats.append(f.chat, [{ role: 'user', content: 'Build', requestId: id }, { role: 'assistant', content: 'Queued', requestId: id, job: link }]);
  f.restart();
  await Promise.all([f.recover(), new ChatJobService(f.chats, f.runtime).recover()]);
  await eventually(() => f.jobs.get(link.jobId, f.alice.userId), job => job?.status === 'completed');
  await f.recover();
  assert.equal((await f.chats.pendingJobs()).length, 0);
  assert.equal((await f.jobs.listForUser(f.alice.userId)).length, 1);
  assert.equal(f.state.opens, 1); assert.equal(f.state.prs, 1);
});

test('cancellation during job creation is durable and cannot provision after the head lookup finishes', async () => {
  const f = await chatJobsFixture();
  let release!: () => void;
  f.state.headGate = new Promise(resolve => { release = resolve; });
  const receipt = await (await f.send()).json();
  const jobId = receipt.messages[1].job.jobId;
  assert.equal((await f.request(`/api/agent-jobs/${jobId}/cancel`, {}, f.other.token)).status, 404);
  const response = await f.request(`/api/agent-jobs/${jobId}/cancel`, {});
  assert.equal(response.status, 200);
  release();
  await eventually(() => f.jobs.get(jobId, f.alice.userId), job => job?.status === 'cancelled');
  f.restart(); await f.recover();
  assert.equal(f.state.opens, 0);
  assert.equal((await saved(f)).jobs[0].status, 'cancelled');
  assert.equal((await f.request(`/api/agent-jobs/${jobId}/resume`, {})).status, 409);
});

test('failed checks and setup are shown in the originating chat; resume reuses the modified workspace', async () => {
  const f = await chatJobsFixture(); f.state.failCheck = true;
  f.state.decision!.scaffold!.directory = 'apps/web';
  const receipt = await (await f.send()).json(), jobId = receipt.messages[1].job.jobId;
  await eventually(() => f.jobs.get(jobId, f.alice.userId), job => job?.status === 'failed' && job.leaseUntil?.getTime() === 0);
  assert.equal((await saved(f)).jobs[0].failure, 'AGENT_CHECK_FAILED');
  assert.ok(f.state.calls.filter(call => ['npm', 'install'].includes(call.command)).every(call => call.cwd.endsWith('/apps/web')));
  assert.equal(f.state.prs, 0);
  f.restart(); f.state.failCheck = false;
  assert.equal((await f.request(`/api/agent-jobs/${jobId}/resume`, {})).status, 202);
  await eventually(() => f.jobs.get(jobId, f.alice.userId), job => job?.status === 'completed');
  assert.equal(f.state.edits, 1); assert.equal(f.state.calls.filter(call => call.command === 'node').length, 1); assert.equal(f.state.prs, 1);
  const otherChat = await f.chats.create(f.alice.userId);
  assert.deepEqual((await (await f.request(`/api/chats/${otherChat.id}`)).json()).jobs, []);
  const broken = await chatJobsFixture(); broken.state.failSetup = 20;
  const setup = await (await broken.send()).json();
  await eventually(() => saved(broken), chat => chat.jobs[0]?.status === 'failed');
  assert.equal((await saved(broken)).jobs[0].failure, 'AGENT_SCAFFOLD_CONFLICT');
  assert.equal(broken.state.edits, 0); assert.equal(broken.state.prs, 0);
  assert.ok(setup.messages[1].job.jobId);
});

test('Stop reply does not cancel a submitted job; Cancel job terminates it without a PR', async () => {
  const f = await chatJobsFixture(); let release!: () => void;
  f.state.editGate = new Promise(resolve => { release = resolve; });
  const receipt = await (await f.send()).json(), jobId = receipt.messages[1].job.jobId;
  await eventually(async () => f.state.edits, edits => edits === 1);
  assert.equal((await (await f.request(`/api/chats/${f.chat.id}/cancel`, {})).json()).cancelled, false);
  assert.equal((await f.jobs.get(jobId, f.alice.userId))?.status, 'running');
  await f.request(`/api/agent-jobs/${jobId}/cancel`, {}); release();
  await eventually(() => f.jobs.get(jobId, f.alice.userId), job => job?.leaseUntil?.getTime() === 0);
  assert.equal((await saved(f)).jobs[0].status, 'cancelled'); assert.equal(f.state.prs, 0);
});

test('Stop does not cancel a submitted job after asynchronous chat handoff', async () => {
  const f = await chatJobsFixture();
  const sending = await f.send();
  assert.equal(sending.status, 200);
  await eventually(() => f.jobs.listForUser(f.alice.userId), jobs => jobs[0]?.status === 'completed');
  assert.equal((await (await f.request(`/api/chats/${f.chat.id}/cancel`, {})).json()).cancelled, false);
  assert.equal(f.state.prs, 1);
});
