import { randomUUID } from "node:crypto";
import { readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AgentGitHubCredentialBroker } from "./credential-broker.js";
import type { AgentJobAuthorization, AgentJobAuthorizationStore } from "./job-authorizations.js";
import type { CommandRunner } from "./process-runner.js";
import { workspaceEnvironment } from "./process-runner.js";
import type { RepositoryAgent } from "./opencode-repository-agent.js";
import type { GitHubPullRequestClient, GitHubRepositoryHeadClient } from "../github/app-client.js";
import type { AgentRepositoryWriteAction, ConnectedRepository, ConnectedRepositoryStore } from "../github/repositories.js";

export interface CreateRepositoryJobInput {
  userId: string;
  repositoryId: number;
  instruction: string;
}

export interface RepositoryExecutionRuntime {
  jobs: AgentJobAuthorizationStore;
  repositories: ConnectedRepositoryStore;
  github: GitHubRepositoryHeadClient & GitHubPullRequestClient;
  credentials: AgentGitHubCredentialBroker;
  commands: CommandRunner;
  agent: RepositoryAgent;
  workspaceRoot?: string;
}

const SAFE_FAILURES = new Set([
  "AGENT_JOB_NOT_AUTHORIZED",
  "AGENT_REPOSITORY_NOT_AUTHORIZED",
  "AGENT_POLICY_DENIED",
  "AGENT_WORKFLOW_MODIFICATION_DENIED",
  "GITHUB_CREDENTIAL_MINT_FAILED",
  "GITHUB_INSTALLATION_CREDENTIAL_EXPIRED",
  "GITHUB_BRANCH_HEAD_LOOKUP_FAILED",
  "AGENT_CLONE_FAILED",
  "AGENT_BASE_CHECKOUT_FAILED",
  "AGENT_BRANCH_CREATE_FAILED",
  "AGENT_NO_CHANGES",
  "AGENT_CHECK_FAILED",
  "AGENT_COMMIT_FAILED",
  "AGENT_PUSH_FAILED",
  "AGENT_PULL_REQUEST_FAILED",
  "AGENT_REMOTE_CHANGED",
  "AGENT_BRANCH_CHANGED",
  "OPENCODE_SESSION_CREATE_FAILED",
  "OPENCODE_REPOSITORY_JOB_FAILED",
]);

function safeFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return SAFE_FAILURES.has(message) ? message : "AGENT_EXECUTION_FAILED";
}

function gitCredentialEnvironment(token: string) {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function repositoryUrl(fullName: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new Error("AGENT_REPOSITORY_NOT_AUTHORIZED");
  return `https://github.com/${fullName}.git`;
}

function workflowChanged(status: string) {
  return status.split("\n").some(line => {
    const path = line.slice(3).trim();
    if (!path) return false;
    return path.split(" -> ").some(candidate => candidate.replace(/^"|"$/g, "").startsWith(".github/workflows/"));
  });
}

function oneLine(value: string, limit: number) {
  return value.trim().replace(/\s+/g, " ").slice(0, limit);
}

export class AgentRepositoryExecutor {
  private workspaceRoot: string;

  constructor(private runtime: RepositoryExecutionRuntime) {
    this.workspaceRoot = resolve(runtime.workspaceRoot || join(tmpdir(), "journey-harness-agent-jobs"));
  }

  private async requirePolicy(
    userId: string,
    repositoryId: number,
    action: AgentRepositoryWriteAction,
  ): Promise<ConnectedRepository> {
    const repository = await this.runtime.repositories.authorizeAgentRepositoryAction(userId, repositoryId, action);
    if (!repository) {
      throw new Error(action === "modifyWorkflows" ? "AGENT_WORKFLOW_MODIFICATION_DENIED" : "AGENT_POLICY_DENIED");
    }
    return repository;
  }

  async createJob(input: CreateRepositoryJobInput) {
    if (!input.instruction.trim() || input.instruction.length > 12_000) throw new Error("INVALID_AGENT_INSTRUCTION");
    const repository = await this.requirePolicy(input.userId, input.repositoryId, "createBranch");
    const baseSha = await this.runtime.github.getRepositoryBranchHead(
      repository.installationId,
      repository.repositoryId,
      repository.fullName,
      repository.defaultBranch,
    );
    const jobId = randomUUID();
    const branch = `journey-harness/${jobId}`;
    if (branch === repository.defaultBranch) throw new Error("AGENT_BRANCH_CREATE_FAILED");
    return this.runtime.jobs.create(jobId, input.userId, input.repositoryId, {
      repositoryFullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      baseSha,
      branch,
      request: input.instruction.trim(),
    });
  }

  private workspace(jobId: string) {
    const path = resolve(this.workspaceRoot, jobId);
    if (!path.startsWith(this.workspaceRoot + sep)) throw new Error("AGENT_EXECUTION_FAILED");
    return path;
  }

  async execute(job: AgentJobAuthorization, instruction: string) {
    if (!job.repositoryFullName || !job.defaultBranch || !job.baseSha || !job.branch) {
      throw new Error("AGENT_JOB_NOT_AUTHORIZED");
    }
    const request = job.request || instruction.trim();
    const workspace = this.workspace(job.jobId);
    await this.runtime.jobs.setStatus(job.jobId, job.userId, "running");
    await this.runtime.jobs.updateExecution(job.jobId, job.userId, { startedAt: new Date(), failure: undefined });
    try {
      await rm(workspace, { recursive: true, force: true });
      await mkdir(this.workspaceRoot, { recursive: true });
      const firstCredential = await this.runtime.credentials.getRepositoryCredential({
        userId: job.userId,
        jobId: job.jobId,
        repositoryId: job.repositoryId,
      });
      const cloneEnv = await workspaceEnvironment(this.workspaceRoot, gitCredentialEnvironment(firstCredential.token));
      const clone = await this.runtime.commands.run("git", [
        "clone", "--no-checkout", "--single-branch", "--branch", job.defaultBranch,
        repositoryUrl(job.repositoryFullName), workspace,
      ], { cwd: this.workspaceRoot, env: cloneEnv, timeoutMs: 5 * 60 * 1000 });
      if (clone.code !== 0) throw new Error("AGENT_CLONE_FAILED");

      const cleanEnv = await workspaceEnvironment(workspace);
      const checkout = await this.runtime.commands.run("git", ["checkout", "--detach", job.baseSha], {
        cwd: workspace, env: cleanEnv,
      });
      if (checkout.code !== 0) throw new Error("AGENT_BASE_CHECKOUT_FAILED");
      await this.requirePolicy(job.userId, job.repositoryId, "createBranch");
      const branch = await this.runtime.commands.run("git", ["switch", "-c", job.branch, job.baseSha], {
        cwd: workspace, env: cleanEnv,
      });
      if (branch.code !== 0) throw new Error("AGENT_BRANCH_CREATE_FAILED");

      await this.runtime.agent.modify(workspace, request);

      const branchNow = await this.runtime.commands.run("git", ["branch", "--show-current"], { cwd: workspace, env: cleanEnv });
      if (branchNow.code !== 0 || branchNow.stdout.trim() !== job.branch) throw new Error("AGENT_BRANCH_CHANGED");
      const remote = await this.runtime.commands.run("git", ["remote", "get-url", "origin"], { cwd: workspace, env: cleanEnv });
      if (remote.code !== 0 || remote.stdout.trim() !== repositoryUrl(job.repositoryFullName)) throw new Error("AGENT_REMOTE_CHANGED");

      const checks = await this.runChecks(workspace, cleanEnv);
      await this.runtime.jobs.updateExecution(job.jobId, job.userId, { checks });
      if (checks.some(check => !check.ok)) throw new Error("AGENT_CHECK_FAILED");

      const status = await this.runtime.commands.run("git", ["status", "--porcelain"], { cwd: workspace, env: cleanEnv });
      if (status.code !== 0 || !status.stdout.trim()) throw new Error("AGENT_NO_CHANGES");
      if (workflowChanged(status.stdout)) await this.requirePolicy(job.userId, job.repositoryId, "modifyWorkflows");

      await this.requirePolicy(job.userId, job.repositoryId, "commit");
      if ((await this.runtime.commands.run("git", ["add", "-A"], { cwd: workspace, env: cleanEnv })).code !== 0) {
        throw new Error("AGENT_COMMIT_FAILED");
      }
      const commit = await this.runtime.commands.run("git", [
        "-c", "user.name=journey-harness Agent",
        "-c", "user.email=agent@journey-harness.local",
        "commit", "-m", `journey-harness agent job ${job.jobId}`,
      ], { cwd: workspace, env: cleanEnv });
      if (commit.code !== 0) throw new Error("AGENT_COMMIT_FAILED");

      const sha = await this.runtime.commands.run("git", ["rev-parse", "HEAD"], { cwd: workspace, env: cleanEnv });
      if (sha.code !== 0 || !/^[0-9a-f]{40}$/i.test(sha.stdout.trim())) throw new Error("AGENT_COMMIT_FAILED");
      const summaryResult = await this.runtime.commands.run("git", ["diff", "--stat", "--summary", `${job.baseSha}..HEAD`], {
        cwd: workspace,
        env: cleanEnv,
      });
      const summary = summaryResult.code === 0 && summaryResult.stdout.trim()
        ? summaryResult.stdout.trim().slice(0, 6_000)
        : `Created commit ${sha.stdout.trim()}.`;

      await this.requirePolicy(job.userId, job.repositoryId, "pushAgentBranch");
      const pushCredential = await this.runtime.credentials.getRepositoryCredential({
        userId: job.userId,
        jobId: job.jobId,
        repositoryId: job.repositoryId,
      });
      const pushEnv = await workspaceEnvironment(workspace, gitCredentialEnvironment(pushCredential.token));
      const push = await this.runtime.commands.run("git", ["push", "origin", `HEAD:refs/heads/${job.branch}`], {
        cwd: workspace, env: pushEnv, timeoutMs: 5 * 60 * 1000,
      });
      if (push.code !== 0) throw new Error("AGENT_PUSH_FAILED");
      await this.runtime.jobs.updateExecution(job.jobId, job.userId, { commitSha: sha.stdout.trim(), summary });

      const repository = await this.requirePolicy(job.userId, job.repositoryId, "openPullRequest");
      let pullRequest;
      try {
        pullRequest = await this.runtime.github.createRepositoryPullRequest(
          repository.installationId,
          repository.repositoryId,
          repository.fullName,
          {
            title: `journey-harness agent: ${oneLine(request, 72)}`,
            body: this.pullRequestBody(job, request, summary, checks),
            head: job.branch,
            base: job.defaultBranch,
          },
        );
      } catch {
        throw new Error("AGENT_PULL_REQUEST_FAILED");
      }

      await this.runtime.jobs.updateExecution(job.jobId, job.userId, {
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        completedAt: new Date(),
      });
      return await this.runtime.jobs.setStatus(job.jobId, job.userId, "completed");
    } catch (error) {
      await this.runtime.jobs.updateExecution(job.jobId, job.userId, {
        failure: safeFailure(error),
        completedAt: new Date(),
      });
      await this.runtime.jobs.setStatus(job.jobId, job.userId, "failed");
      throw new Error(safeFailure(error));
    } finally {
      this.runtime.credentials.invalidateJob(job.userId, job.jobId);
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }

  private pullRequestBody(
    job: AgentJobAuthorization,
    request: string,
    summary: string,
    checks: Array<{ command: string; ok: boolean }>,
  ) {
    const checkLines = checks.length
      ? checks.map(check => `- ${check.ok ? "PASS" : "FAIL"}: \`${check.command}\``).join("\n")
      : "No repository checks were detected.";
    return [
      "## journey-harness agent job",
      "",
      `- Job: \`${job.jobId}\``,
      `- Base: \`${job.baseSha}\` on \`${job.defaultBranch}\``,
      `- Agent branch: \`${job.branch}\``,
      "",
      "## Request",
      "",
      request,
      "",
      "## Summary",
      "",
      "```text",
      summary,
      "```",
      "",
      "## Checks",
      "",
      checkLines,
      "",
      "## Known failures / limitations",
      "",
      "No known executor failures were reported. Human review is required; journey-harness does not automatically merge this pull request.",
    ].join("\n");
  }

  private async runChecks(workspace: string, env: Record<string, string>) {
    const checks: Array<{ command: string; ok: boolean }> = [];
    let packageJson: { scripts?: Record<string, string> } | undefined;
    try {
      packageJson = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));
    } catch {}
    const scripts = packageJson?.scripts || {};
    for (const [name, args] of [
      ["check", ["run", "check"]],
      ["test", ["test"]],
      ["build", ["run", "build"]],
    ] as const) {
      if (!scripts[name]) continue;
      const result = await this.runtime.commands.run("npm", [...args], {
        cwd: workspace,
        env,
        timeoutMs: 10 * 60 * 1000,
      });
      checks.push({ command: `npm ${args.join(" ")}`, ok: result.code === 0 });
      if (result.code !== 0) break;
    }
    return checks;
  }
}
