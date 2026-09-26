import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DaytonaExecutionEnvironment } from "../src/agents/daytona-environment.js";
import { MemoryAgentJobAuthorizationStore } from "../src/agents/job-authorizations.js";

/** Opt-in paid integration test; never provisions resources during the default test suite. */
test("live Daytona OpenCode edit/check smoke", { skip: process.env.DAYTONA_LIVE_TEST !== "1", timeout: 25 * 60 * 1000 }, async () => {
  const jobs = new MemoryAgentJobAuthorizationStore();
  const job = await jobs.create(randomUUID(), "live-smoke", 1);
  const environment = new DaytonaExecutionEnvironment();
  try {
    const workspace = await environment.open(job, jobs);
    const env = await workspace.environment(workspace.path);
    assert.equal((await workspace.commands.run("git", ["init", workspace.path], { cwd: "/tmp", env })).code, 0);
    await workspace.agent.modify(workspace.path, "Create smoke.txt containing exactly DAYTONA_SMOKE_OK followed by a newline. Do not modify any other file.");
    assert.equal((await workspace.readText(`${workspace.path}/smoke.txt`)).trim(), "DAYTONA_SMOKE_OK");
    assert.equal((await workspace.commands.run("git", ["diff", "--check"], { cwd: workspace.path, env })).code, 0);
  } finally {
    await environment.cancel((await jobs.get(job.jobId, job.userId))!, jobs);
  }
});
