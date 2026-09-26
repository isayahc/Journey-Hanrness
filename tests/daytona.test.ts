import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Daytona, Sandbox } from "@daytona/sdk";
import { DaytonaCommandRunner, DaytonaExecutionEnvironment, executionEnvironmentFromEnv, shellArgument } from "../src/agents/daytona-environment.js";
import { MemoryAgentJobAuthorizationStore } from "../src/agents/job-authorizations.js";

/** Deterministic Daytona API fixture: no remote resources or provider credentials. */
async function fixture() {
  const jobs = new MemoryAgentJobAuthorizationStore();
  const job = await jobs.create("12345678-1234-1234-1234-123456789abc", "alice", 123);
  const calls: Array<{ command: string; env?: Record<string, string>; timeout?: number }> = [];
  let deleted = 0;
  let stopped = 0;
  let started = 0;
  let created = 0;
  let failCreate = false;
  let failDelete = false;
  let params: unknown;
  const sandbox = {
    id: "sandbox-1", state: "started", labels: { "journey-owner": createHash("sha256").update("alice").digest("hex"), "journey-job": job.jobId },
    process: { executeCommand: async (command: string, _cwd?: string, env?: Record<string, string>, timeout?: number) => {
      calls.push({ command, env, timeout });
      return { exitCode: 0, result: "" };
    } },
    getPreviewLink: async () => ({ url: "https://private.example", token: "preview-secret" }),
  } as unknown as Sandbox;
  const client = {
    create: async (input: unknown) => { created++; params = input; if (failCreate) throw new Error("secret-token"); return sandbox; },
    get: async () => sandbox,
    start: async () => { started++; },
    stop: async () => { stopped++; },
    delete: async () => { deleted++; if (failDelete) throw new Error("secret-token"); },
  } as unknown as Pick<Daytona, "create" | "get" | "start" | "stop" | "delete">;
  const http: typeof fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("x-daytona-preview-token"), "preview-secret");
    return new Response('{"healthy":true}', { status: 200 });
  };
  const environment = new DaytonaExecutionEnvironment({}, client, http);
  return { jobs, job, environment, sandbox, calls,
    get metrics() { return { deleted, stopped, started, created, params }; },
    failCreate: () => { failCreate = true; }, failDelete: () => { failDelete = true; },
  };
}

test("Daytona provisions a private bounded workspace, persists ownership, and deletes success", async () => {
  const state = await fixture();
  const workspace = await state.environment.open(state.job, state.jobs);
  const saved = await state.jobs.get(state.job.jobId, "alice");
  assert.equal(saved?.sandbox?.id, "sandbox-1");
  assert.equal(saved?.sandbox?.state, "running");
  assert.equal(await state.jobs.get(state.job.jobId, "mallory"), null);
  assert.deepEqual((state.metrics.params as { resources: unknown }).resources, { cpu: 2, memory: 4, disk: 10 });
  assert.equal((state.metrics.params as { public: boolean }).public, false);
  assert.equal((state.metrics.params as { ttlMinutes: number }).ttlMinutes, 1440);
  assert(state.calls.some(call => call.command.includes("opencode-ai@1.18.32")));
  assert(!JSON.stringify(saved).includes("preview-secret"));
  assert(!JSON.stringify(saved).includes("OPENCODE_SERVER_PASSWORD"));
  await workspace.close(true, false);
  assert.equal(state.metrics.deleted, 1);
  assert.equal((await state.jobs.get(state.job.jobId, "alice"))?.sandbox?.state, "deleted");
});

test("failure retains progress; reconnect checks labels and stops old processes without duplicating sandbox", async () => {
  const state = await fixture();
  const workspace = await state.environment.open(state.job, state.jobs);
  await state.jobs.updateExecution(state.job.jobId, "alice", { checkpoint: "modified" });
  await workspace.close(false, false);
  const saved = (await state.jobs.get(state.job.jobId, "alice"))!;
  assert.equal(saved.sandbox?.state, "stopped");
  await state.environment.open(saved, state.jobs);
  assert.equal(state.metrics.created, 1);
  assert.equal(state.metrics.started, 1);
  assert.equal((await state.jobs.get(state.job.jobId, "alice"))?.checkpoint, "modified");
  state.sandbox.labels = { "journey-owner": "someone-else" };
  await assert.rejects(state.environment.open(saved, state.jobs), /SANDBOX_OWNER_MISMATCH/);
  assert.equal(state.metrics.started, 1);
});

test("provisioning and cleanup errors are sanitized and leave recoverable lifecycle records", async () => {
  const state = await fixture();
  state.failCreate();
  await assert.rejects(state.environment.open(state.job, state.jobs), /^Error: SANDBOX_PROVISION_FAILED$/);
  const record = (await state.jobs.get(state.job.jobId, "alice"))!;
  assert.equal(record.sandbox?.state, "provisioning");
  assert(!JSON.stringify(record).includes("secret-token"));
  const workspace = await state.environment.open(record, state.jobs);
  state.failDelete();
  await workspace.close(true, false);
  assert.equal((await state.jobs.get(state.job.jobId, "alice"))?.sandbox?.state, "cleanup_failed");
});

test("cancellation deletes the correct sandbox and blocks further commands", async () => {
  const state = await fixture();
  const workspace = await state.environment.open(state.job, state.jobs);
  await state.jobs.setStatus(state.job.jobId, "alice", "cancelled");
  await assert.rejects(workspace.commands.run("git", ["status"], { cwd: workspace.path }), /AGENT_JOB_NOT_AUTHORIZED/);
  await state.environment.cancel((await state.jobs.get(state.job.jobId, "alice"))!, state.jobs);
  assert.equal(state.metrics.deleted, 1);
  await workspace.close(false, true);
  assert.equal(state.metrics.deleted, 1);
});

test("argv quoting, command time bounds, and credential output redaction", async () => {
  assert.equal(shellArgument("a'$(touch /tmp/pwn)"), "'a'\\''$(touch /tmp/pwn)'");
  const state = await fixture();
  const runner = new DaytonaCommandRunner(state.sandbox, async () => {});
  await runner.run("echo", ["a; touch /tmp/pwn"], { cwd: "/tmp", timeoutMs: 9999999 });
  assert.equal(state.calls[0]?.timeout, 900);
  assert.equal(state.calls[0]?.command, "'echo' 'a; touch /tmp/pwn'");
  state.sandbox.process.executeCommand = async () => ({ exitCode: 0, result: "secret-token" });
  assert.equal((await runner.run("git", ["push"], { cwd: "/tmp", env: { GIT_CONFIG_VALUE_0: "secret-token" } })).stdout, "");
  state.sandbox.process.executeCommand = async () => { throw new Error("secret-token timeout"); };
  await assert.rejects(runner.run("git", ["status"], { cwd: "/tmp" }), /^Error: SANDBOX_COMMAND_FAILED$/);
});

test("job claims exclude another owner, duplicate workers, and cancelled/completed jobs", async () => {
  const { jobs, job } = await fixture();
  const lease = new Date(Date.now() + 60000);
  assert.equal(await jobs.claim(job.jobId, "mallory", lease), null);
  const claims = await Promise.all([jobs.claim(job.jobId, "alice", lease), jobs.claim(job.jobId, "alice", lease)]);
  assert.equal(claims.filter(Boolean).length, 1);
  await jobs.updateExecution(job.jobId, "alice", { leaseUntil: new Date(0) });
  assert(await jobs.claim(job.jobId, "alice", lease));
  await jobs.setStatus(job.jobId, "alice", "cancelled");
  assert.equal(await jobs.claim(job.jobId, "alice", lease), null);
});

test("execution backend configuration fails closed", () => {
  assert.equal(executionEnvironmentFromEnv({ JOURNEY_AGENT_EXECUTION_BACKEND: "local" }), undefined);
  assert.throws(() => executionEnvironmentFromEnv({ JOURNEY_AGENT_EXECUTION_BACKEND: "typo" }), /INVALID_EXECUTION_BACKEND/);
  assert.throws(() => executionEnvironmentFromEnv({ JOURNEY_AGENT_EXECUTION_BACKEND: "daytona" }), /DAYTONA_API_KEY_REQUIRED/);
});
