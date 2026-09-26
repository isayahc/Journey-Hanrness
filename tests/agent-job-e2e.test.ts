import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentGitHubCredentialBroker } from "../src/agents/credential-broker.js";
import { MemoryAgentJobAuthorizationStore } from "../src/agents/job-authorizations.js";
import type { RepositoryAgent } from "../src/agents/opencode-repository-agent.js";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/agents/process-runner.js";
import { AgentRepositoryExecutor } from "../src/agents/repository-executor.js";
import type { GitHubInstallationVerifier } from "../src/auth/github.js";
import { MemoryAuthStore } from "../src/auth/store.js";
import { createChatApp } from "../src/chat/app.js";
import { DemoChatProvider } from "../src/chat/provider.js";
import { MemoryChatStore } from "../src/chat/store.js";
import type {
  GitHubAppRepositoryClient,
  GitHubInstallationCredentialMinter,
  GitHubInstallationRepository,
  GitHubPullRequestClient,
  GitHubRepositoryHeadClient,
  GitHubRepositoryInitializer,
} from "../src/github/app-client.js";
import { MemoryGitHubInstallationStore } from "../src/github/installations.js";
import { MemoryConnectedRepositoryStore } from "../src/github/repositories.js";

class FakeOAuth {
  authorizationUrl(state: string) {
    return `https://github.example/login?state=${encodeURIComponent(state)}`;
  }

  async exchangeCode() {
    return { id: 100, login: "alice" };
  }
}

class NoopVerifier implements GitHubInstallationVerifier {
  installationAuthorizationUrl(state: string, callbackUrl: string) {
    const url = new URL("https://github.example/verify");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", callbackUrl);
    return url.toString();
  }

  async verifyInstallationCode(_code: string, _callbackUrl: string, _installationId: number | null) {
    return {
      profile: { id: 100, login: "alice" },
      installations: [],
    };
  }
}

class FakeGitHub implements
  GitHubAppRepositoryClient,
  GitHubRepositoryHeadClient,
  GitHubRepositoryInitializer,
  GitHubPullRequestClient,
  GitHubInstallationCredentialMinter {
  pullRequests: Array<{
    installationId: number;
    repositoryId: number;
    fullName: string;
    input: { title: string; body: string; head: string; base: string };
  }> = [];

  async listInstallationRepositories(): Promise<GitHubInstallationRepository[]> {
    return [{
      repositoryId: 101,
      fullName: "alice/project",
      defaultBranch: "main",
      private: true,
      archived: false,
    }];
  }

  async getRepositoryBranchHead() {
    return "a".repeat(40);
  }

  async initializeRepository() {}

  async mintRepositoryCredential() {
    return {
      token: "repo-scoped-test-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
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
  async modify(workspace: string) {
    await writeFile(join(workspace, "changed.txt"), "changed\n", "utf8");
  }
}

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; options: CommandOptions }> = [];
  currentBranch = "";

  async run(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
    this.calls.push({
      command,
      args: [...args],
      options: { ...options, env: options.env ? { ...options.env } : undefined },
    });

    if (command === "git" && args[0] === "clone") {
      const target = args.at(-1)!;
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "package.json"), JSON.stringify({
        scripts: {
          check: "echo check",
          test: "echo test",
          build: "echo build",
        },
      }), "utf8");
    }
    if (command === "git" && args[0] === "switch") this.currentBranch = args[2]!;
    if (command === "git" && args[0] === "branch") {
      return { code: 0, stdout: this.currentBranch + "\n", stderr: "" };
    }
    if (command === "git" && args[0] === "remote") {
      return { code: 0, stdout: "https://github.com/alice/project.git\n", stderr: "" };
    }
    if (command === "git" && args[0] === "status") {
      return { code: 0, stdout: " M changed.txt\n", stderr: "" };
    }
    if (command === "git" && args[0] === "rev-parse") {
      return { code: 0, stdout: "b".repeat(40) + "\n", stderr: "" };
    }
    if (command === "git" && args[0] === "diff") {
      return {
        code: 0,
        stdout: " changed.txt | 1 +\n 1 file changed, 1 insertion(+)\n",
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  }
}

function request(path: string, token: string, body?: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: `journey_session=${token}`,
      ...(body === undefined
        ? {}
        : { origin: "http://localhost:3000", "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("authenticated repository enablement reaches branch push and pull request end to end", async () => {
  const auth = new MemoryAuthStore();
  const identity = await auth.bindGitHubUser({ id: 100, login: "alice" });
  const session = await auth.createSession(identity.userId);
  const installations = new MemoryGitHubInstallationStore();
  const repositories = new MemoryConnectedRepositoryStore();
  const jobs = new MemoryAgentJobAuthorizationStore();
  const github = new FakeGitHub();
  const commands = new FakeRunner();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "journey-agent-e2e-"));

  await installations.linkInstallation(identity.userId, {
    installationId: 55,
    accountId: 100,
    accountLogin: "alice",
    accountType: "User",
    repositorySelection: "selected",
    permissions: { metadata: "read", contents: "write", pull_requests: "write" },
  });
  await repositories.syncInstallation(identity.userId, 55, [{
    repositoryId: 101,
    fullName: "alice/project",
    defaultBranch: "main",
    private: true,
    archived: false,
  }]);

  const credentials = new AgentGitHubCredentialBroker(jobs, repositories, github);
  const executor = new AgentRepositoryExecutor({
    jobs,
    repositories,
    github,
    credentials,
    commands,
    agent: new FakeAgent(),
    workspaceRoot,
  });
  const app = createChatApp(
    new MemoryChatStore(),
    new DemoChatProvider(),
    true,
    3000,
    { store: auth, github: new FakeOAuth() },
    "http://localhost:3000",
    {
      slug: "journey-harness",
      store: installations,
      verifier: new NoopVerifier(),
      repositoryStore: repositories,
      repositoryClient: github,
      credentialBroker: credentials,
      jobStore: jobs,
      repositoryExecutor: executor,
    },
  );

  try {
    const initialList = await app(request("/api/github/repositories", session.token));
    assert.equal(initialList.status, 200);
    const [initialRepository] = await initialList.json();
    assert.equal(initialRepository.repositoryId, 101);
    assert.equal(initialRepository.agentEnabled, false);

    const enabled = await app(request(
      "/api/github/repositories/101/agent-access",
      session.token,
      { enabled: true },
    ));
    assert.equal(enabled.status, 200);
    assert.equal((await enabled.json()).agentEnabled, true);

    const createdResponse = await app(request("/api/agent-jobs", session.token, {
      repositoryId: 101,
      instruction: "Add a changed.txt marker",
    }));
    assert.equal(createdResponse.status, 202);
    const created = await createdResponse.json();
    const history = await app(request("/api/agent-jobs", session.token));
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json()).map((job: { jobId: string }) => job.jobId), [created.jobId]);
    const other = await auth.bindGitHubUser({ id: 98765, login: "other" });
    const otherSession = await auth.createSession(other.userId);
    assert.deepEqual(await (await app(request("/api/agent-jobs", otherSession.token))).json(), []);
    assert.equal((await app(request("/api/agent-jobs", "invalid"))).status, 401);
    assert.match(created.branch, /^journey-harness\/[0-9a-f-]{36}$/);
    assert.equal(created.defaultBranch, "main");
    assert.equal(created.repositoryFullName, "alice/project");

    let completed: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      const jobResponse = await app(request(`/api/agent-jobs/${created.jobId}`, session.token));
      assert.equal(jobResponse.status, 200);
      completed = await jobResponse.json();
      if (completed.status === "completed" || completed.status === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.equal(completed?.status, "completed");
    assert.equal(completed.pullRequestNumber, 42);
    assert.equal(completed.pullRequestUrl, "https://github.com/alice/project/pull/42");
    assert.equal(completed.commitSha, "b".repeat(40));
    assert.match(completed.summary, /changed\.txt/);

    const push = commands.calls.find(call => call.command === "git" && call.args[0] === "push");
    assert.deepEqual(push?.args, ["push", "origin", `HEAD:refs/heads/${created.branch}`]);
    assert.equal(push?.args.includes("--force"), false);
    assert.equal(push?.args.some(arg => arg === "main" || arg.endsWith("/main")), false);

    assert.equal(github.pullRequests.length, 1);
    assert.equal(github.pullRequests[0]?.repositoryId, 101);
    assert.equal(github.pullRequests[0]?.input.head, created.branch);
    assert.equal(github.pullRequests[0]?.input.base, "main");
    assert.match(github.pullRequests[0]?.input.body || "", /Human review is required/);

    const disabled = await app(request(
      "/api/github/repositories/101/agent-access",
      session.token,
      { enabled: false },
    ));
    assert.equal(disabled.status, 200);

    const denied = await app(request("/api/agent-jobs", session.token, {
      repositoryId: 101,
      instruction: "This should not run",
    }));
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /not authorized/i);
    assert.equal(github.pullRequests.length, 1);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
