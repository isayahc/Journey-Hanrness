import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { GitHubAppClient } from "../src/github/app-client.js";
import { MemoryConnectedRepositoryStore } from "../src/github/repositories.js";

test("GitHub pull requests use a repository-scoped installation token", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = request.method === "GET" ? "" : await request.text();
    requests.push({
      url: request.url,
      method: request.method,
      ...(text ? { body: JSON.parse(text) } : {}),
    });
    if (request.url.includes("/app/installations/55/access_tokens")) {
      return Response.json({
        token: "ghs_pr_test",
        expires_at: "2026-09-23T00:00:00Z",
      }, { status: 201 });
    }
    if (request.url === "https://api.github.com/repos/alice/project/pulls") {
      return Response.json({
        number: 7,
        html_url: "https://github.com/alice/project/pull/7",
      }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  };
  const client = new GitHubAppClient(
    "123",
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fakeFetch,
    () => Date.parse("2026-09-22T23:00:00Z"),
  );

  const result = await client.createRepositoryPullRequest(55, 101, "alice/project", {
    title: "journey-harness agent: change project",
    body: "Review this agent change.",
    head: "journey-harness/job-1",
    base: "main",
  });

  assert.deepEqual(result, {
    number: 7,
    url: "https://github.com/alice/project/pull/7",
  });
  assert.deepEqual(requests[0], {
    url: "https://api.github.com/app/installations/55/access_tokens",
    method: "POST",
    body: {
      repository_ids: [101],
      permissions: { contents: "read", pull_requests: "write" },
    },
  });
  assert.deepEqual(requests[1], {
    url: "https://api.github.com/repos/alice/project/pulls",
    method: "POST",
    body: {
      title: "journey-harness agent: change project",
      body: "Review this agent change.",
      head: "journey-harness/job-1",
      base: "main",
    },
  });
});

test("connected repositories default to branch-and-PR policy with dangerous writes disabled", async () => {
  const repositories = new MemoryConnectedRepositoryStore();
  await repositories.syncInstallation("alice", 55, [{
    repositoryId: 101,
    fullName: "alice/project",
    defaultBranch: "main",
    private: true,
    archived: false,
  }]);
  await repositories.setAgentEnabled("alice", 101, true);

  const repository = await repositories.authorizeAgentRepository("alice", 101);
  assert.deepEqual(repository?.agentPolicy, {
    read: true,
    createBranch: true,
    commit: true,
    pushAgentBranch: true,
    openPullRequest: true,
    directPushDefaultBranch: false,
    mergePullRequests: false,
    modifyWorkflows: false,
  });
  assert.ok(await repositories.authorizeAgentRepositoryAction("alice", 101, "createBranch"));
  assert.ok(await repositories.authorizeAgentRepositoryAction("alice", 101, "openPullRequest"));
  assert.equal(await repositories.authorizeAgentRepositoryAction("alice", 101, "modifyWorkflows"), null);

  await repositories.setAgentEnabled("alice", 101, false);
  assert.equal(await repositories.authorizeAgentRepositoryAction("alice", 101, "openPullRequest"), null);
});
