import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

/** Uses an already running configured server and an explicitly authorized disposable repository. */
test('live chat → Daytona → checks → GitHub PR, including retry and persisted reload', {
  skip: process.env.CHAT_DAYTONA_LIVE_TEST !== '1', timeout: 30 * 60 * 1000,
}, async () => {
  const origin = new URL(process.env.JOURNEY_SMOKE_ORIGIN || 'http://localhost:3000').origin;
  const token = process.env.JOURNEY_SMOKE_SESSION;
  const repository = process.env.JOURNEY_SMOKE_REPOSITORY;
  assert.ok(token && repository, 'Set JOURNEY_SMOKE_SESSION and JOURNEY_SMOKE_REPOSITORY for the disposable repository');
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(105000),
      headers: { origin, cookie: `journey_session=${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.ok, true, `HTTP ${response.status} for ${path}`);
    return response.json();
  };
  const chat = await api('/api/chats', {}), requestId = randomUUID();
  const body = { requestId, content: `Create a minimal Next.js app at the root of ${repository}. Use system fonts so the build needs no font download. Add a simple welcome page and verify the production build. Make the changes now and open a pull request.` };
  let jobId: string | undefined, completed = false;
  try {
    const first = await api(`/api/chats/${chat.id}/messages`, body);
    jobId = first.messages.find((message: any) => message.job)?.job.jobId;
    assert.ok(jobId, 'Chat did not submit a job; check repository opt-in, model routing and Daytona configuration');
    await api(`/api/chats/${chat.id}/messages`, body);
    const deadline = Date.now() + 25 * 60 * 1000;
    while (Date.now() < deadline) {
      const jobs = await api(`/api/chats/${chat.id}/jobs`);
      assert.equal(jobs.length, 1);
      const job = jobs[0];
      assert.equal(job.jobId, jobId);
      assert.ok(!['failed', 'cancelled', 'submission_failed'].includes(job.status), `Job failed: ${job.failure || job.status}`);
      if (job.status === 'completed') {
        assert.ok(job.sandbox?.id); assert.equal(job.sandbox.state, 'deleted');
        assert.ok(job.checks.some((check: any) => check.command === 'npm run build' && check.ok));
        assert.ok(job.checks.every((check: any) => check.ok));
        assert.match(job.pullRequestUrl, /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/);
        const reloaded = await api(`/api/chats/${chat.id}`);
        assert.equal(reloaded.jobs[0].pullRequestUrl, job.pullRequestUrl);
        assert.equal(reloaded.messages.length, 2);
        completed = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    assert.ok(completed, 'Job timed out');
  } finally {
    if (jobId && !completed) await api(`/api/agent-jobs/${jobId}/cancel`, {}).catch(() => {});
  }
});
