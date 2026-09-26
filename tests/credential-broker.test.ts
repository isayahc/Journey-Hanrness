import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { MongoClient } from "mongodb";
import { AgentGitHubCredentialBroker } from "../src/agents/credential-broker.js";
import {
  MemoryAgentJobAuthorizationStore,
  MongoAgentJobAuthorizationStore,
  type AgentJobAuthorization,
} from "../src/agents/job-authorizations.js";
import {
  GitHubAppClient,
  type GitHubInstallationCredentialMinter,
} from "../src/github/app-client.js";
import {
  MemoryConnectedRepositoryStore,
  type ConnectedRepository,
} from "../src/github/repositories.js";

async function authorizedFixture() {
  const jobs = new MemoryAgentJobAuthorizationStore();
  const repositories = new MemoryConnectedRepositoryStore();
  await jobs.create("job-1", "alice", 101);
  await repositories.syncInstallation("alice", 55, [{
    repositoryId: 101,
    fullName: "alice/project",
    defaultBranch: "main",
    private: true,
    archived: false,
  }]);
  await repositories.setAgentEnabled("alice", 101, true);
  return { jobs, repositories };
}

test("broker mints only for exact active job and enabled user repository", async () => {
  const { jobs, repositories } = await authorizedFixture();
  const calls: unknown[] = [];
  const minter: GitHubInstallationCredentialMinter = {
    async mintRepositoryCredential(installationId, repositoryId, permissions) {
      calls.push({ installationId, repositoryId, permissions });
      return { token: "secret-token", expiresAt: new Date(Date.now() + 60 * 60 * 1000) };
    },
  };
  const broker = new AgentGitHubCredentialBroker(jobs, repositories, minter);

  const credential = await broker.getRepositoryCredential({
    userId: "alice",
    jobId: "job-1",
    repositoryId: 101,
  });
  assert.equal(credential.token, "secret-token");
  assert.deepEqual(calls, [{
    installationId: 55,
    repositoryId: 101,
    permissions: { contents: "write", pull_requests: "write" },
  }]);

  await assert.rejects(
    broker.getRepositoryCredential({ userId: "bob", jobId: "job-1", repositoryId: 101 }),
    /AGENT_JOB_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    broker.getRepositoryCredential({ userId: "alice", jobId: "job-1", repositoryId: 999 }),
    /AGENT_JOB_NOT_AUTHORIZED/,
  );
  assert.equal(calls.length, 1);
});

test("disabled repository and completed job cannot reuse a cached credential", async () => {
  const { jobs, repositories } = await authorizedFixture();
  let mints = 0;
  const minter: GitHubInstallationCredentialMinter = {
    async mintRepositoryCredential() {
      mints++;
      return { token: `token-${mints}`, expiresAt: new Date(Date.now() + 60 * 60 * 1000) };
    },
  };
  const broker = new AgentGitHubCredentialBroker(jobs, repositories, minter);
  const request = { userId: "alice", jobId: "job-1", repositoryId: 101 };

  await broker.getRepositoryCredential(request);
  assert.equal(mints, 1);

  await repositories.setAgentEnabled("alice", 101, false);
  await assert.rejects(broker.getRepositoryCredential(request), /AGENT_REPOSITORY_NOT_AUTHORIZED/);
  assert.equal(mints, 1);

  await repositories.setAgentEnabled("alice", 101, true);
  await jobs.setStatus("job-1", "alice", "completed");
  await assert.rejects(broker.getRepositoryCredential(request), /AGENT_JOB_NOT_AUTHORIZED/);
  assert.equal(mints, 1);
});

test("broker reuses healthy in-memory credential and refreshes before expiry", async () => {
  const { jobs, repositories } = await authorizedFixture();
  let now = 1_800_000_000_000;
  let mints = 0;
  const minter: GitHubInstallationCredentialMinter = {
    async mintRepositoryCredential() {
      mints++;
      return { token: `token-${mints}`, expiresAt: new Date(now + 60 * 60 * 1000) };
    },
  };
  const broker = new AgentGitHubCredentialBroker(jobs, repositories, minter, () => now);
  const request = { userId: "alice", jobId: "job-1", repositoryId: 101 };

  const first = await broker.getRepositoryCredential(request);
  const second = await broker.getRepositoryCredential(request);
  assert.equal(first.token, "token-1");
  assert.equal(second.token, "token-1");
  assert.equal(mints, 1);

  now += 56 * 60 * 1000;
  const refreshed = await broker.getRepositoryCredential(request);
  assert.equal(refreshed.token, "token-2");
  assert.equal(mints, 2);

  broker.invalidateJob("alice", "job-1");
  const afterInvalidation = await broker.getRepositoryCredential(request);
  assert.equal(afterInvalidation.token, "token-3");
  assert.equal(mints, 3);
});

test("credential mint errors are redacted", async () => {
  const { jobs, repositories } = await authorizedFixture();
  const minter: GitHubInstallationCredentialMinter = {
    async mintRepositoryCredential() {
      throw new Error("upstream leaked token ghs_super_secret");
    },
  };
  const broker = new AgentGitHubCredentialBroker(jobs, repositories, minter);
  await assert.rejects(
    broker.getRepositoryCredential({ userId: "alice", jobId: "job-1", repositoryId: 101 }),
    error => error instanceof Error
      && error.message === "GITHUB_CREDENTIAL_MINT_FAILED"
      && !error.message.includes("ghs_super_secret"),
  );
});

test("GitHub App client scopes installation token to one repository and minimal permissions", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let body: unknown;
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    body = JSON.parse(await request.text());
    return Response.json({
      token: "ghs_test",
      expires_at: "2026-09-21T00:00:00Z",
    }, { status: 201 });
  };
  const client = new GitHubAppClient(
    "123",
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fakeFetch,
    () => Date.parse("2026-09-20T23:00:00Z"),
  );
  const credential = await client.mintRepositoryCredential(55, 101, {
    contents: "write",
    pull_requests: "write",
  });
  assert.equal(credential.token, "ghs_test");
  assert.equal(credential.expiresAt.toISOString(), "2026-09-21T00:00:00.000Z");
  assert.deepEqual(body, {
    repository_ids: [101],
    permissions: { contents: "write", pull_requests: "write" },
  });
});

test("Mongo agent job authorization stores no credential material", { skip: !process.env.MONGODB_TEST_URI }, async () => {
  const client = new MongoClient(process.env.MONGODB_TEST_URI!);
  await client.connect();
  const database = client.db(`journey_creds_test_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    const store = new MongoAgentJobAuthorizationStore(
      database.collection<AgentJobAuthorization>("agent_jobs"),
    );
    await store.init();
    await store.create("job-1", "alice", 101);
    assert.ok(await store.authorizeCredentialJob("alice", "job-1", 101));
    assert.equal(await store.authorizeCredentialJob("bob", "job-1", 101), null);
    assert.equal(await store.authorizeCredentialJob("alice", "job-1", 102), null);

    const raw = await database.collection("agent_jobs").findOne({ jobId: "job-1" });
    assert.equal("token" in (raw || {}), false);
    assert.equal("credential" in (raw || {}), false);

    await store.setStatus("job-1", "alice", "completed");
    assert.equal(await store.authorizeCredentialJob("alice", "job-1", 101), null);
  } finally {
    try { await database.dropDatabase(); }
    finally { await client.close(); }
  }
});
