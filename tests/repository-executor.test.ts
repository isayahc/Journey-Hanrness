import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentGitHubCredentialBroker } from "../src/agents/credential-broker.js";
import { MemoryAgentJobAuthorizationStore } from "../src/agents/job-authorizations.js";
import type { RepositoryAgent } from "../src/agents/opencode-repository-agent.js";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/agents/process-runner.js";
import { AgentRepositoryExecutor } from "../src/agents/repository-executor.js";
import type {
  GitHubAppRepositoryClient,
  GitHubPullRequestClient,
  GitHubRepositoryHeadClient,
  GitHubInstallationCredentialMinter,
  GitHubInstallationRepository,
} from "../src/github/app-client.js";
import { MemoryConnectedRepositoryStore } from "../src/github/repositories.js";

class FakeGitHub implements GitHubAppRepositoryClient, GitHubRepositoryHeadClient, GitHubPullRequestClient, GitHubInstallationCredentialMinter {
  mints = 0;
  pullRequests: Array<{
    installationId: number;
    repositoryId: number;
    fullName: string;
    input: { title: string; body: string; head: string; base: string };
  }> = [];

  async listInstallationRepositories(): Promise<GitHubInstallationRepository[]> { return []; }
  async getRepositoryBranchHead() { return "a".repeat(40); }
  async mintRepositoryCredential() {
    this.mints++;
    return { token: `token-${this.mints}`, expiresAt: new Date(Date.now() + 60 * 60 * 1000) };
  }
  async createRepositoryPullRequest(
    installationId: number,
    repositoryId: number,
    fullName: string,
    input: { title: string; body: string; head: string; base: string },
  ) {
    this.pullRequests.push({ installationId, repositoryId, fullName, input });
    return { number: 42, url: "https://github.com/alice/project/pull/42" };
  }
}

class FakeAgent implements RepositoryAgent {
  workspaces: string[] = [];
  async modify(workspace: string) {
    this.workspaces.push(workspace);
    await writeFile(join(workspace, "changed.txt"), "changed\n", "utf8");
  }
}

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; options: CommandOptions }> = [];
  currentBranch = "";
  failCommand?: string;
  statusOutput = " M changed.txt\n";

  async run(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args: [...args], options: { ...options, env: options.env ? { ...options.env } : undefined } });
    const signature = `${command} ${args.join(" ")}`;
    if (this.failCommand && signature.startsWith(this.failCommand)) return { code: 1, stdout: "", stderr: "simulated failure" };

    if (command === "git" && args[0] === "clone") {
      const target = args.at(-1)!;
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "package.json"), JSON.stringify({
        scripts: { check: "echo check", test: "echo test", build: "echo build" },
      }), "utf8");
    }
    if (command === "git" && args[0] === "switch") this.currentBranch = args[2]!;
    if (command === "git" && args[0] === "branch") return { code: 0, stdout: this.currentBranch + "\n", stderr: "" };
    if (command === "git" && args[0] === "remote") return { code: 0, stdout: "https://github.com/alice/project.git\n", stderr: "" };
    if (command === "git" && args[0] === "status") return { code: 0, stdout: this.statusOutput, stderr: "" };
    if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "b".repeat(40) + "\n", stderr: "" };
    if (command === "git" && args[0] === "diff") return { code: 0, stdout: " changed.txt | 1 +\n 1 file changed, 1 insertion(+)\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
}

async function fixture() {
  const jobs = new MemoryAgentJobAuthorizationStore();
  const repositories = new MemoryConnectedRepositoryStore();
  await repositories.syncInstallation("alice", 55, [{
    repositoryId: 101,
    fullName: "alice/project",
    defaultBranch: "main",
    private: true,
    archived: false,
  }]);
  await repositories.setAgentEnabled("alice", 101, true);
  const github = new FakeGitHub();
  const credentials = new AgentGitHubCredentialBroker(jobs, repositories, github);
  const commands = new FakeRunner();
  const agent = new FakeAgent();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "journey-executor-test-"));
  const executor = new AgentRepositoryExecutor({
    jobs, repositories, github, credentials, commands, agent, workspaceRoot,
  });
  return { jobs, repositories, github, credentials, commands, agent, workspaceRoot, executor };
}

test("job records base metadata, pushes only its agent branch, and opens a reviewable PR", async () => {
  const state = await fixture();
  const job = await state.executor.createJob({
    userId: "alice",
    repositoryId: 101,
    instruction: "Change the project",
  });
  assert.equal(job.repositoryFullName, "alice/project");
  assert.equal(job.defaultBranch, "main");
  assert.equal(job.baseSha, "a".repeat(40));
  assert.equal(job.request, "Change the project");
  assert.match(job.branch || "", /^journey-harness\/[0-9a-f-]{36}$/);
  assert.notEqual(job.branch, "main");

  const completed = await state.executor.execute(job, "Change the project");
  assert.equal(completed?.status, "completed");
  const stored = await state.jobs.get(job.jobId, "alice");
  assert.equal(stored?.commitSha, "b".repeat(40));
  assert.equal(stored?.pullRequestNumber, 42);
  assert.equal(stored?.pullRequestUrl, "https://github.com/alice/project/pull/42");
  assert.match(stored?.summary || "", /changed\.txt/);

  const checkout = state.commands.calls.find(call => call.command === "git" && call.args[0] === "checkout");
  assert.deepEqual(checkout?.args, ["checkout", "--detach", "a".repeat(40)]);
  const switchCall = state.commands.calls.find(call => call.command === "git" && call.args[0] === "switch");
  assert.deepEqual(switchCall?.args, ["switch", "-c", job.branch!, "a".repeat(40)]);

  const push = state.commands.calls.find(call => call.command === "git" && call.args[0] === "push");
  assert.deepEqual(push?.args, ["push", "origin", `HEAD:refs/heads/${job.branch}`]);
  assert.equal(push?.args.includes("--force"), false);
  assert.equal(push?.args.some(arg => arg === "main" || arg.endsWith("/main")), false);

  const checks = state.commands.calls
    .filter(call => call.command === "npm")
    .map(call => `npm ${call.args.join(" ")}`);
  assert.deepEqual(checks, ["npm run check", "npm test", "npm run build"]);

  assert.equal(state.github.pullRequests.length, 1);
  const pullRequest = state.github.pullRequests[0]!;
  assert.equal(pullRequest.installationId, 55);
  assert.equal(pullRequest.repositoryId, 101);
  assert.equal(pullRequest.fullName, "alice/project");
  assert.equal(pullRequest.input.head, job.branch);
  assert.equal(pullRequest.input.base, "main");
  assert.match(pullRequest.input.body, /Change the project/);
  assert.match(pullRequest.input.body, /npm test/);
  assert.match(pullRequest.input.body, /Human review is required/);

  assert.equal(state.agent.workspaces.length, 1);
  await assert.rejects(access(state.agent.workspaces[0]!));
});

test("git credentials are passed only to clone/push process environment and never arguments", async () => {
  const state = await fixture();
  const job = await state.executor.createJob({ userId: "alice", repositoryId: 101, instruction: "Change it" });
  await state.executor.execute(job, "Change it");

  for (const call of state.commands.calls) {
    assert.equal(call.args.join(" ").includes("token-"), false);
  }
  const clone = state.commands.calls.find(call => call.command === "git" && call.args[0] === "clone")!;
  const push = state.commands.calls.find(call => call.command === "git" && call.args[0] === "push")!;
  assert.match(clone.options.env?.GIT_CONFIG_VALUE_0 || "", /^AUTHORIZATION: basic /);
  assert.match(push.options.env?.GIT_CONFIG_VALUE_0 || "", /^AUTHORIZATION: basic /);

  for (const call of state.commands.calls.filter(call => call !== clone && call !== push)) {
    assert.equal(call.options.env?.GIT_CONFIG_VALUE_0, undefined);
  }
});

test("one job cannot be created for an unauthorized second repository", async () => {
  const state = await fixture();
  await state.repositories.syncInstallation("alice", 56, [{
    repositoryId: 202,
    fullName: "alice/other",
    defaultBranch: "main",
    private: true,
    archived: false,
  }]);
  await assert.rejects(
    state.executor.createJob({ userId: "alice", repositoryId: 202, instruction: "Change other repo" }),
    /AGENT_(REPOSITORY_NOT_AUTHORIZED|POLICY_DENIED)/,
  );
});

test("failed checks persist sanitized failure and clean the workspace without pushing", async () => {
  const state = await fixture();
  state.commands.failCommand = "npm test";
  const job = await state.executor.createJob({ userId: "alice", repositoryId: 101, instruction: "Break it" });
  await assert.rejects(state.executor.execute(job, "Break it"), /AGENT_CHECK_FAILED/);

  const stored = await state.jobs.get(job.jobId, "alice");
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.failure, "AGENT_CHECK_FAILED");
  assert.equal(stored?.checks?.at(-1)?.ok, false);
  assert.equal(state.commands.calls.some(call => call.command === "git" && call.args[0] === "push"), false);
  assert.equal(state.github.pullRequests.length, 0);
  await assert.rejects(access(state.agent.workspaces[0]!));
  assert.equal(JSON.stringify(stored).includes("token-"), false);
});

test("default repository policy denies workflow modification even when the agent requests it", async () => {
  const state = await fixture();
  const [repository] = await state.repositories.listForUser("alice");
  assert.equal(repository?.agentPolicy?.createBranch, true);
  assert.equal(repository?.agentPolicy?.commit, true);
  assert.equal(repository?.agentPolicy?.pushAgentBranch, true);
  assert.equal(repository?.agentPolicy?.openPullRequest, true);
  assert.equal(repository?.agentPolicy?.directPushDefaultBranch, false);
  assert.equal(repository?.agentPolicy?.mergePullRequests, false);
  assert.equal(repository?.agentPolicy?.modifyWorkflows, false);

  state.commands.statusOutput = "?? .github/workflows/ci.yml\n";
  const job = await state.executor.createJob({
    userId: "alice",
    repositoryId: 101,
    instruction: "Please change the CI workflow",
  });
  await assert.rejects(state.executor.execute(job, "Please change the CI workflow"), /AGENT_WORKFLOW_MODIFICATION_DENIED/);

  const stored = await state.jobs.get(job.jobId, "alice");
  assert.equal(stored?.failure, "AGENT_WORKFLOW_MODIFICATION_DENIED");
  assert.equal(state.commands.calls.some(call => call.command === "git" && call.args[0] === "commit"), false);
  assert.equal(state.commands.calls.some(call => call.command === "git" && call.args[0] === "push"), false);
  assert.equal(state.github.pullRequests.length, 0);
});

test("branch tampering is rejected before commit, push, or pull request", async () => {
  const branchState = await fixture();
  const branchJob = await branchState.executor.createJob({ userId: "alice", repositoryId: 101, instruction: "Change it" });
  branchState.commands.run = async function(command, args, options) {
    this.calls.push({ command, args: [...args], options });
    if (command === "git" && args[0] === "clone") {
      await mkdir(args.at(-1)!, { recursive: true });
      await writeFile(join(args.at(-1)!, "package.json"), "{}", "utf8");
    }
    if (command === "git" && args[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(branchState.executor.execute(branchJob, "Change it"), /AGENT_BRANCH_CHANGED/);
  assert.equal(branchState.commands.calls.some(call => call.command === "git" && call.args[0] === "push"), false);
  assert.equal(branchState.github.pullRequests.length, 0);
});
