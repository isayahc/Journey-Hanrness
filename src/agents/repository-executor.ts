import { fencedJobStore, JOB_LEASE_MS } from "./job-authorizations.js";
import { resolveOpenCodeModel } from "../opencode-model.js";
import { scaffoldInput, type ScaffoldInput } from "../chat/execution.js";
import { scaffoldNextApp } from "./scaffold.js";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AgentGitHubCredentialBroker } from "./credential-broker.js";
import type {
  AgentJobAuthorization,
  AgentJobAuthorizationStore,
} from "./job-authorizations.js";
import type { CommandRunner } from "./process-runner.js";
import {
  localWorkspace,
  type ExecutionEnvironment,
  type ExecutionWorkspace,
} from "./execution-environment.js";
import type { RepositoryAgent } from "./opencode-repository-agent.js";
import type {
  GitHubPullRequestClient,
  GitHubRepositoryInitializer,
  GitHubRepositoryHeadClient,
} from "../github/app-client.js";
import type {
  AgentRepositoryWriteAction,
  ConnectedRepository,
  ConnectedRepositoryStore,
} from "../github/repositories.js";

export interface CreateRepositoryJobInput {
  userId: string;
  repositoryId: number;
  instruction: string;
  jobId?: string;
  scaffold?: ScaffoldInput;
  chat?: { id: string; requestId: string };
  executionBackend?: "daytona";
  model?: string;
  deadlineAt?: Date;
  run?: { id: string; stepId: string };
  parentJobId?: string;
}

export interface RepositoryExecutionRuntime {
  jobs: AgentJobAuthorizationStore;
  repositories: ConnectedRepositoryStore;
  github: GitHubRepositoryHeadClient & GitHubRepositoryInitializer & GitHubPullRequestClient;
  credentials: AgentGitHubCredentialBroker;
  commands: CommandRunner;
  agent: RepositoryAgent;
  workspaceRoot?: string;
  environment?: ExecutionEnvironment;
}

const SAFE_FAILURES = new Set([
  "DAYTONA_REQUIRED",
  "AGENT_LEASE_LOST",
  "AGENT_DEADLINE_EXCEEDED",
  "AGENT_SCAFFOLD_FAILED",
  "AGENT_SCAFFOLD_CONFLICT",
  "AGENT_SCAFFOLD_PATH_DENIED",
  "AGENT_JOB_NOT_AUTHORIZED",
  "AGENT_RECOVERY_REQUIRES_RECONCILIATION",
  "AGENT_WORKSPACE_RECOVERY_REQUIRED",
  "SANDBOX_COMMAND_FAILED",
  "SANDBOX_PROVISION_FAILED",
  "SANDBOX_RECONNECT_FAILED",
  "SANDBOX_RUNTIME_FAILED",
  "SANDBOX_OWNER_MISMATCH",
  "SANDBOX_EXPIRED",
  "AGENT_REPOSITORY_NOT_AUTHORIZED",
  "AGENT_POLICY_DENIED",
  "AGENT_WORKFLOW_MODIFICATION_DENIED",
  "GITHUB_CREDENTIAL_MINT_FAILED",
  "GITHUB_INSTALLATION_CREDENTIAL_EXPIRED",
  "GITHUB_BRANCH_HEAD_LOOKUP_FAILED",
  "GITHUB_REPOSITORY_INITIALIZATION_FAILED",
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
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName))
    throw new Error("AGENT_REPOSITORY_NOT_AUTHORIZED");
  return `https://github.com/${fullName}.git`;
}

function workflowChanged(status: string) {
  return status.split("\n").some((line) => {
    const path = line.slice(3).trim();
    if (!path) return false;
    return path
      .split(" -> ")
      .some((candidate) =>
        candidate.replace(/^"|"$/g, "").startsWith(".github/workflows/"),
      );
  });
}

function oneLine(value: string, limit: number) {
  return value.trim().replace(/\s+/g, " ").slice(0, limit);
}

export class AgentRepositoryExecutor {
  private workspaceRoot: string;
  get backend() { return this.runtime.environment?.backend || "local"; }

  constructor(private runtime: RepositoryExecutionRuntime) {
    this.workspaceRoot = resolve(
      runtime.workspaceRoot || join(tmpdir(), "journey-harness-agent-jobs"),
    );
  }

  private async requirePolicy(
    userId: string,
    repositoryId: number,
    action: AgentRepositoryWriteAction,
  ): Promise<ConnectedRepository> {
    const repository =
      await this.runtime.repositories.authorizeAgentRepositoryAction(
        userId,
        repositoryId,
        action,
      );
    if (!repository) {
      throw new Error(
        action === "modifyWorkflows"
          ? "AGENT_WORKFLOW_MODIFICATION_DENIED"
          : "AGENT_POLICY_DENIED",
      );
    }
    return repository;
  }

  async createJob(input: CreateRepositoryJobInput) {
    if (input.executionBackend === "daytona" && this.backend !== "daytona") throw new Error("DAYTONA_REQUIRED");
    const scaffold = input.scaffold ? scaffoldInput.parse(input.scaffold) : undefined;
    if (scaffold && this.backend !== "daytona") throw new Error("DAYTONA_REQUIRED");
    const jobId = input.jobId || randomUUID();
    if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new Error("AGENT_JOB_NOT_AUTHORIZED");
    const model = input.model ? resolveOpenCodeModel({ OPENCODE_MODEL: input.model }).name : undefined;
    if (input.deadlineAt && input.deadlineAt <= new Date()) throw new Error("AGENT_DEADLINE_EXCEEDED");
    const existing = await this.runtime.jobs.get(jobId, input.userId);
    const verifyExisting = (job: AgentJobAuthorization) => {
      if (job.repositoryId !== input.repositoryId || job.request !== input.instruction.trim()
        || JSON.stringify(job.scaffold) !== JSON.stringify(scaffold)
        || JSON.stringify(job.chat) !== JSON.stringify(input.chat)
        || job.executionBackend !== input.executionBackend
        || job.model !== model || +new Date(job.deadlineAt || 0) !== +new Date(input.deadlineAt || 0)
        || JSON.stringify(job.run) !== JSON.stringify(input.run) || job.parentJobId !== input.parentJobId) throw new Error("AGENT_JOB_NOT_AUTHORIZED");
      return job;
    };
    if (existing) return verifyExisting(existing);
    if (!input.instruction.trim() || input.instruction.length > 12_000)
      throw new Error("INVALID_AGENT_INSTRUCTION");
    const repository = await this.requirePolicy(
      input.userId,
      input.repositoryId,
      "createBranch",
    );
    const parent = input.parentJobId ? await this.runtime.jobs.get(input.parentJobId, input.userId) : null;
    if (input.parentJobId && (!parent || parent.repositoryId !== input.repositoryId || parent.status !== "completed"
      || !parent.commitSha || !parent.branch || !parent.run || parent.run.id !== input.run?.id)) throw new Error("AGENT_JOB_NOT_AUTHORIZED");
    const baseBranch = parent?.branch || repository.defaultBranch;
    let baseSha = await this.runtime.github.getRepositoryBranchHead(
      repository.installationId,
      repository.repositoryId,
      repository.fullName,
      baseBranch,
    );
    if (parent && baseSha !== parent.commitSha) throw new Error("AGENT_RECOVERY_REQUIRES_RECONCILIATION");
    if (!baseSha) {
      await this.runtime.github.initializeRepository(
        repository.installationId,
        repository.repositoryId,
        repository.fullName,
        repository.defaultBranch,
      );
      baseSha = await this.runtime.github.getRepositoryBranchHead(
        repository.installationId,
        repository.repositoryId,
        repository.fullName,
        repository.defaultBranch,
      );
      if (!baseSha) throw new Error("GITHUB_REPOSITORY_INITIALIZATION_FAILED");
    }
    const branch = `journey-harness/${jobId}`;
    if (branch === repository.defaultBranch)
      throw new Error("AGENT_BRANCH_CREATE_FAILED");
    try { return await this.runtime.jobs.create(jobId, input.userId, input.repositoryId, {
      repositoryFullName: repository.fullName,
      defaultBranch: baseBranch,
      baseSha,
      branch,
      request: input.instruction.trim(),
      ...(scaffold ? { scaffold, checkDirectory: scaffold.directory } : parent?.checkDirectory ? { checkDirectory: parent.checkDirectory } : {}), ...(input.chat ? { chat: input.chat } : {}),
      ...(input.executionBackend ? { executionBackend: input.executionBackend } : {}),
      ...(model ? { model } : {}), ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
      ...(input.run ? { run: input.run } : {}), ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}),
    }); } catch (error) {
      const concurrent = await this.runtime.jobs.get(jobId, input.userId);
      if (concurrent) return verifyExisting(concurrent);
      throw error;
    }
  }

  private workspace(jobId: string) {
    const path = resolve(this.workspaceRoot, jobId);
    if (!path.startsWith(this.workspaceRoot + sep))
      throw new Error("AGENT_EXECUTION_FAILED");
    return path;
  }

  async execute(job: AgentJobAuthorization, instruction: string, runAttempt?: number) {
    if (
      !job.repositoryFullName ||
      !job.defaultBranch ||
      !job.baseSha ||
      !job.branch
    ) {
      throw new Error("AGENT_JOB_NOT_AUTHORIZED");
    }
    // Always reload persisted authorization; callers cannot substitute owner/repository metadata.
    const claimed = await this.runtime.jobs.claim(
      job.jobId,
      job.userId,
      new Date(Date.now() + JOB_LEASE_MS),
    );
    if (!claimed) throw new Error("AGENT_JOB_NOT_AUTHORIZED");
    job = claimed;
    const jobs = fencedJobStore(this.runtime.jobs, claimed);
    let lostLease = false;
    const owns = async () => {
      const saved = await this.runtime.jobs.get(job.jobId, job.userId);
      return !!saved && saved.leaseToken === claimed.leaseToken && !!saved.leaseUntil
        && saved.leaseUntil > new Date() && saved.status !== "cancelled";
    };
    const active = async () => {
      if (lostLease || !await owns()) throw new Error("AGENT_LEASE_LOST");
      if (job.deadlineAt && job.deadlineAt <= new Date()) throw new Error("AGENT_DEADLINE_EXCEEDED");
    };
    const heartbeat = setInterval(() => {
      void jobs.updateExecution(job.jobId, job.userId, { leaseUntil: new Date(Date.now() + JOB_LEASE_MS) })
        .catch(() => { lostLease = true; });
    }, JOB_LEASE_MS / 3);
    heartbeat.unref();
    const request = job.request || instruction.trim();
    let session: ExecutionWorkspace | undefined;
    let success = false;
    try {
      await active();
      await jobs.updateExecution(job.jobId, job.userId, { startedAt: job.startedAt || new Date(), failure: undefined, ...(runAttempt ? { runAttempt } : {}) });
      if (job.executionBackend === "daytona" && this.backend !== "daytona") throw new Error("DAYTONA_REQUIRED");
      if (
        !job.repositoryFullName ||
        !job.defaultBranch ||
        !job.baseSha ||
        !job.branch ||
        job.branch === job.defaultBranch ||
        job.branch !== `journey-harness/${job.jobId}`
      ) {
        throw new Error("AGENT_JOB_NOT_AUTHORIZED");
      }
      const authorized = await this.requirePolicy(
        job.userId,
        job.repositoryId,
        "createBranch",
      );
      let recoveredPullRequest;
      if (
        job.checkpoint === "push_pending" ||
        job.checkpoint === "pr_pending"
      ) {
        try {
          const head = await this.runtime.github.getRepositoryBranchHead(
            authorized.installationId,
            job.repositoryId,
            job.repositoryFullName,
            job.branch,
          );
          if (head !== job.commitSha) throw new Error("HEAD_MISMATCH");
          if (job.checkpoint === "pr_pending") {
            if (!this.runtime.github.findRepositoryPullRequest)
              throw new Error("LOOKUP_UNAVAILABLE");
            recoveredPullRequest =
              await this.runtime.github.findRepositoryPullRequest(
                authorized.installationId,
                job.repositoryId,
                job.repositoryFullName,
                job.branch,
                job.defaultBranch,
              );
          }
          job.checkpoint = "pushed";
          await jobs.updateExecution(job.jobId, job.userId, {
            checkpoint: "pushed",
          });
        } catch {
          throw new Error("AGENT_RECOVERY_REQUIRES_RECONCILIATION");
        }
      }
      if (
        recoveredPullRequest ||
        (job.checkpoint === "completed" && job.pullRequestUrl)
      ) {
        if (recoveredPullRequest) {
          await jobs.updateExecution(job.jobId, job.userId, {
            checkpoint: "completed",
            pullRequestNumber: recoveredPullRequest.number,
            pullRequestUrl: recoveredPullRequest.url,
            completedAt: new Date(),
            artifacts: [
              { kind: "diff", uri: `${recoveredPullRequest.url}/files` },
              { kind: "checks", uri: `job:${job.jobId}:checks` },
            ],
          });
        }
        success = true;
        await jobs.setStatus(job.jobId, job.userId, "completed");
        try {
          await this.runtime.environment?.cancel?.(job, jobs);
        } catch {}
        return jobs.get(job.jobId, job.userId);
      }
      if (!this.runtime.environment && job.checkpoint)
        throw new Error("AGENT_WORKSPACE_RECOVERY_REQUIRED");
      session = this.runtime.environment
        ? await this.runtime.environment.open(job, jobs)
        : await localWorkspace(
            this.workspace(job.jobId),
            this.runtime.commands,
            this.runtime.agent,
          );
      const rawCommands = session.commands;
      session.commands = { run: async (command, args, options) => {
        await active();
        const remaining = job.deadlineAt ? +job.deadlineAt - Date.now() : Infinity;
        const result = await rawCommands.run(command, args, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 120_000, remaining) });
        await active(); return result;
      } };
      const workspace = session.path;
      const root = session.root ?? resolve(workspace, "..");
      const commands = session.commands;
      if (!job.checkpoint) {
        const firstCredential =
          await this.runtime.credentials.getRepositoryCredential({
            userId: job.userId,
            jobId: job.jobId,
            repositoryId: job.repositoryId,
          });
        const cloneEnv = await session.environment(
          root,
          gitCredentialEnvironment(firstCredential.token),
        );
        const clone = await commands.run(
          "git",
          [
            "clone",
            "--no-checkout",
            "--single-branch",
            "--branch",
            job.defaultBranch,
            repositoryUrl(job.repositoryFullName),
            workspace,
          ],
          { cwd: root, env: cloneEnv, timeoutMs: 5 * 60 * 1000 },
        );
        if (clone.code !== 0) throw new Error("AGENT_CLONE_FAILED");

        const cleanEnv = await session.environment(workspace);
        const checkout = await commands.run(
          "git",
          ["checkout", "--detach", job.baseSha],
          {
            cwd: workspace,
            env: cleanEnv,
          },
        );
        if (checkout.code !== 0) throw new Error("AGENT_BASE_CHECKOUT_FAILED");
        await this.requirePolicy(job.userId, job.repositoryId, "createBranch");
        const branch = await commands.run(
          "git",
          ["switch", "-c", job.branch, job.baseSha],
          {
            cwd: workspace,
            env: cleanEnv,
          },
        );
        if (branch.code !== 0) throw new Error("AGENT_BRANCH_CREATE_FAILED");

        await jobs.updateExecution(job.jobId, job.userId, {
          checkpoint: "workspace",
        });
      }
      const cleanEnv = await session.environment(workspace);
      if ((!job.checkpoint || job.checkpoint === "workspace") && job.scaffold) {
        if (this.backend !== "daytona") throw new Error("DAYTONA_REQUIRED");
        await scaffoldNextApp(session, job.jobId, job.scaffold);
        await jobs.updateExecution(job.jobId, job.userId, { checkpoint: "scaffolded" });
      }
      if (!job.checkpoint || ["workspace", "scaffolded"].includes(job.checkpoint)) {
        const setup = job.scaffold ? `\nThe harness has scaffolded Next.js in ${job.scaffold.directory}. Customize those files for this request. Do not run setup commands; dependencies and checks run afterward.` : "";
        await active();
        await session.agent.modify(workspace, request + setup, { model: job.model, deadlineAt: job.deadlineAt });
        await active();
        await jobs.updateExecution(job.jobId, job.userId, {
          checkpoint: "modified",
        });
      }

      const branchNow = await commands.run(
        "git",
        ["branch", "--show-current"],
        { cwd: workspace, env: cleanEnv },
      );
      if (branchNow.code !== 0 || branchNow.stdout.trim() !== job.branch)
        throw new Error("AGENT_BRANCH_CHANGED");
      const remote = await commands.run(
        "git",
        ["remote", "get-url", "origin"],
        { cwd: workspace, env: cleanEnv },
      );
      if (
        remote.code !== 0 ||
        remote.stdout.trim() !== repositoryUrl(job.repositoryFullName)
      )
        throw new Error("AGENT_REMOTE_CHANGED");

      let checks = job.checks || [];
      if (!["committed", "pushed"].includes(job.checkpoint || "")) {
        checks = await this.runChecks(session, cleanEnv, job.checkDirectory || job.scaffold?.directory);
        await jobs.updateExecution(job.jobId, job.userId, {
          checks,
        });
        if (checks.some((check) => !check.ok))
          throw new Error("AGENT_CHECK_FAILED");

        const status = await commands.run("git", ["status", "--porcelain"], {
          cwd: workspace,
          env: cleanEnv,
        });
        if (status.code !== 0 || !status.stdout.trim())
          throw new Error("AGENT_NO_CHANGES");
        if (workflowChanged(status.stdout))
          await this.requirePolicy(
            job.userId,
            job.repositoryId,
            "modifyWorkflows",
          );

        await this.requirePolicy(job.userId, job.repositoryId, "commit");
        if (
          (
            await commands.run("git", ["add", "-A"], {
              cwd: workspace,
              env: cleanEnv,
            })
          ).code !== 0
        ) {
          throw new Error("AGENT_COMMIT_FAILED");
        }
        const commit = await commands.run(
          "git",
          [
            "-c",
            "user.name=journey-harness Agent",
            "-c",
            "user.email=agent@journey-harness.local",
            "commit",
            "-m",
            `journey-harness agent job ${job.jobId}`,
          ],
          { cwd: workspace, env: cleanEnv },
        );
        if (commit.code !== 0) throw new Error("AGENT_COMMIT_FAILED");
      }
      const sha = await commands.run("git", ["rev-parse", "HEAD"], {
        cwd: workspace,
        env: cleanEnv,
      });
      if (sha.code !== 0 || !/^[0-9a-f]{40}$/i.test(sha.stdout.trim()))
        throw new Error("AGENT_COMMIT_FAILED");
      const summaryResult = await commands.run(
        "git",
        ["diff", "--stat", "--summary", `${job.baseSha}..HEAD`],
        {
          cwd: workspace,
          env: cleanEnv,
        },
      );
      const summary =
        summaryResult.code === 0 && summaryResult.stdout.trim()
          ? summaryResult.stdout.trim().slice(0, 6_000)
          : `Created commit ${sha.stdout.trim()}.`;

      if (!["committed", "pushed"].includes(job.checkpoint || "")) {
        await jobs.updateExecution(job.jobId, job.userId, {
          checkpoint: "committed",
          commitSha: sha.stdout.trim(),
          summary,
        });
      } else if (sha.stdout.trim() !== job.commitSha) {
        throw new Error("AGENT_WORKSPACE_RECOVERY_REQUIRED");
      }
      if (job.checkpoint !== "pushed") {
        await this.requirePolicy(
          job.userId,
          job.repositoryId,
          "pushAgentBranch",
        );
        const pushCredential =
          await this.runtime.credentials.getRepositoryCredential({
            userId: job.userId,
            jobId: job.jobId,
            repositoryId: job.repositoryId,
          });
        // Repository checks are executable code: revalidate Git state after they finish.
        const pushBranch = await commands.run(
          "git",
          ["branch", "--show-current"],
          { cwd: workspace, env: cleanEnv },
        );
        const pushRemote = await commands.run(
          "git",
          ["remote", "get-url", "--push", "origin"],
          { cwd: workspace, env: cleanEnv },
        );
        if (pushBranch.code !== 0 || pushBranch.stdout.trim() !== job.branch)
          throw new Error("AGENT_BRANCH_CHANGED");
        if (
          pushRemote.code !== 0 ||
          pushRemote.stdout.trim() !== repositoryUrl(job.repositoryFullName)
        )
          throw new Error("AGENT_REMOTE_CHANGED");
        const pushEnv = await session.environment(
          workspace,
          gitCredentialEnvironment(pushCredential.token),
        );
        await jobs.updateExecution(job.jobId, job.userId, {
          checkpoint: "push_pending",
        });
        const push = await commands.run(
          "git",
          ["push", "origin", `HEAD:refs/heads/${job.branch}`],
          {
            cwd: workspace,
            env: pushEnv,
            timeoutMs: 5 * 60 * 1000,
          },
        );
        if (push.code !== 0) throw new Error("AGENT_PUSH_FAILED");
        await jobs.updateExecution(job.jobId, job.userId, {
          checkpoint: "pushed",
          commitSha: sha.stdout.trim(),
          summary,
        });
      }

      if (
        !(await jobs.authorizeCredentialJob(
          job.userId,
          job.jobId,
          job.repositoryId,
        ))
      )
        throw new Error("AGENT_JOB_NOT_AUTHORIZED");
      const repository = await this.requirePolicy(
        job.userId,
        job.repositoryId,
        "openPullRequest",
      );
      await jobs.updateExecution(job.jobId, job.userId, {
        checkpoint: "pr_pending",
      });
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

      await jobs.updateExecution(job.jobId, job.userId, {
        checkpoint: "completed",
        artifacts: [
          { kind: "diff", uri: `${pullRequest.url}/files` },
          { kind: "checks", uri: `job:${job.jobId}:checks` },
        ],
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        completedAt: new Date(),
      });
      success = true;
      return await jobs.setStatus(
        job.jobId,
        job.userId,
        "completed",
      );
    } catch (error) {
      if (!await owns()) throw new Error("AGENT_LEASE_LOST");
      await jobs.updateExecution(job.jobId, job.userId, {
        failure: safeFailure(error),
        completedAt: new Date(),
      });
      if (
        (await jobs.get(job.jobId, job.userId))?.status !==
        "cancelled"
      ) {
        await jobs.setStatus(job.jobId, job.userId, "failed");
      }
      throw new Error(safeFailure(error));
    } finally {
      clearInterval(heartbeat);
      // A replaced worker must not stop/delete the replacement's workspace or release its lease.
      if (await owns()) {
        this.runtime.credentials.invalidateJob(job.userId, job.jobId);
        try { await session?.close(success, false); }
        finally { await jobs.updateExecution(job.jobId, job.userId, { leaseUntil: new Date(0) }).catch(() => {}); }
      }
    }
  }

  /** Owner-scoped cancellation also terminates the remote sandbox when present. */
  async cancel(
    jobId: string,
    userId: string,
  ): Promise<AgentJobAuthorization | null> {
    const job = await this.runtime.jobs.get(jobId, userId);
    if (!job) return null;
    if (job.status === "completed") return job;
    await this.runtime.jobs.setStatus(jobId, userId, "cancelled");
    await this.runtime.jobs.updateExecution(jobId, userId, { leaseUntil: new Date(0) });
    this.runtime.credentials.invalidateJob(userId, jobId);
    try {
      await this.runtime.environment?.cancel?.(job, this.runtime.jobs);
    } catch {
      /* Recorded cleanup failure and provider TTL remain available for reconciliation. */
    }
    return this.runtime.jobs.get(jobId, userId);
  }

  private pullRequestBody(
    job: AgentJobAuthorization,
    request: string,
    summary: string,
    checks: Array<{ command: string; ok: boolean }>,
  ) {
    const checkLines = checks.length
      ? checks
          .map(
            (check) => `- ${check.ok ? "PASS" : "FAIL"}: \`${check.command}\``,
          )
          .join("\n")
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

  private async runChecks(
    session: ExecutionWorkspace,
    env: Record<string, string>,
    directory = ".",
  ) {
    const workspace = directory === "." ? session.path : `${session.path}/${directory}`;
    const commands = session.commands;
    const checks: Array<{ command: string; ok: boolean }> = [];
    let packageJson: { scripts?: Record<string, string> } | undefined;
    try {
      packageJson = JSON.parse(
        await session.readText(`${workspace}/package.json`),
      );
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw new Error("AGENT_CHECK_FAILED");
    }
    const scripts = packageJson?.scripts || {};
    if (["check", "test", "build"].some((name) => scripts[name])) {
      const install = await session.prepareChecks?.(workspace);
      if (install) { checks.push(install); if (!install.ok) return checks; }
    }
    for (const [name, args] of [
      ["check", ["run", "check"]],
      ["test", ["test"]],
      ["build", ["run", "build"]],
    ] as const) {
      if (!scripts[name]) continue;
      const result = await commands.run("npm", [...args], {
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
