import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { MongoClient } from "mongodb";
import type { GitHubInstallationVerifier } from "../src/auth/github.js";
import { MemoryAuthStore } from "../src/auth/store.js";
import { GitHubAppClient, type GitHubAppRepositoryClient } from "../src/github/app-client.js";
import { MemoryGitHubInstallationStore } from "../src/github/installations.js";
import {
  MemoryConnectedRepositoryStore,
  MongoConnectedRepositoryStore,
  type ConnectedRepository,
} from "../src/github/repositories.js";
import { createChatApp } from "../src/chat/app.js";
import { DemoChatProvider } from "../src/chat/provider.js";
import { MemoryChatStore } from "../src/chat/store.js";

const repo = (repositoryId: number, fullName: string, archived = false) => ({
  repositoryId,
  fullName,
  defaultBranch: "main",
  private: true,
  archived,
});

test("connected repository authorization is user-scoped and revoked on sync removal", async () => {
  const store = new MemoryConnectedRepositoryStore();
  await store.syncInstallation("alice", 10, [repo(1, "alice/one"), repo(2, "alice/two")]);
  await store.syncInstallation("bob", 20, [repo(1, "bob/one")]);

  assert.equal((await store.listForUser("alice")).length, 2);
  assert.equal((await store.setAgentEnabled("alice", 1, true))?.agentEnabled, true);
  assert.equal((await store.authorizeAgentRepository("alice", 1))?.fullName, "alice/one");
  assert.equal(await store.authorizeAgentRepository("bob", 2), null);
  assert.equal(await store.setAgentEnabled("bob", 2, true), null);

  await store.syncInstallation("alice", 10, [repo(2, "alice/two")]);
  assert.equal(await store.authorizeAgentRepository("alice", 1), null);
  assert.equal((await store.listForUser("alice")).some(item => item.repositoryId === 1), false);

  await store.syncInstallation("alice", 10, [repo(1, "alice/one")]);
  const restored = (await store.listForUser("alice")).find(item => item.repositoryId === 1);
  assert.equal(restored?.agentEnabled, false);
});

test("archived repositories cannot be enabled for agents", async () => {
  const store = new MemoryConnectedRepositoryStore();
  await store.syncInstallation("alice", 10, [repo(3, "alice/archive", true)]);
  assert.equal(await store.setAgentEnabled("alice", 3, true), null);
  assert.equal(await store.authorizeAgentRepository("alice", 3), null);
});

test("GitHub App client mints an installation token and paginates repositories", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls: { url: string; method: string; authorization: string }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization") || "",
    });
    if (request.url.includes("/access_tokens")) {
      return Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 3600000).toISOString() });
    }
    const page = Number(new URL(request.url).searchParams.get("page"));
    if (page === 1) {
      return Response.json({
        total_count: 101,
        repositories: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          full_name: `org/repo-${index + 1}`,
          default_branch: "main",
          private: true,
          archived: false,
        })),
      });
    }
    return Response.json({
      total_count: 101,
      repositories: [{ id: 101, full_name: "org/repo-101", default_branch: "trunk", private: false, archived: false }],
    });
  };
  const client = new GitHubAppClient(
    "123",
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fakeFetch,
    () => 1_800_000_000_000,
  );
  const repositories = await client.listInstallationRepositories(55);
  assert.equal(repositories.length, 101);
  assert.equal(repositories.at(-1)?.defaultBranch, "trunk");
  assert.match(calls[0]?.authorization || "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[1]?.authorization, "Bearer installation-token");
  assert.equal(calls[2]?.authorization, "Bearer installation-token");
});

class FakeOAuth {
  authorizationUrl(state: string) { return `https://github.example/login?state=${state}`; }
  async exchangeCode() { return { id: 100, login: "alice" }; }
}
class NoopVerifier implements GitHubInstallationVerifier {
  installationAuthorizationUrl() { return "https://github.example/verify"; }
  async verifyInstallationCode() { return { profile: { id: 100, login: "alice" }, installations: [] }; }
}
class MutableRepoClient implements GitHubAppRepositoryClient {
  byInstallation = new Map<number, ReturnType<typeof repo>[]>();
  async listInstallationRepositories(installationId: number) {
    return this.byInstallation.get(installationId) || [];
  }
}

async function runtime() {
  const auth = new MemoryAuthStore();
  const identity = await auth.bindGitHubUser({ id: 100, login: "alice" });
  const session = await auth.createSession(identity.userId);
  const installations = new MemoryGitHubInstallationStore();
  await installations.linkInstallation(identity.userId, {
    installationId: 10,
    accountId: 500,
    accountLogin: "alice",
    accountType: "User",
    repositorySelection: "selected",
    permissions: { metadata: "read", contents: "write", pull_requests: "write" },
  });
  const repositoryStore = new MemoryConnectedRepositoryStore();
  const repositoryClient = new MutableRepoClient();
  repositoryClient.byInstallation.set(10, [repo(1, "alice/one"), repo(2, "alice/two")]);
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
      repositoryStore,
      repositoryClient,
    },
  );
  return { app, identity, session, installations, repositoryStore, repositoryClient };
}

function post(path: string, token: string, body: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      cookie: `journey_session=${token}`,
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("repository API syncs, enables, and blocks stale repositories", async () => {
  const state = await runtime();
  const sync = await state.app(post("/api/github/repositories/sync", state.session.token, {}));
  assert.equal(sync.status, 200);
  assert.equal((await sync.json()).length, 2);

  const enabled = await state.app(post("/api/github/repositories/1/agent-access", state.session.token, { enabled: true }));
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).agentEnabled, true);
  assert.ok(await state.repositoryStore.authorizeAgentRepository(state.identity.userId, 1));

  state.repositoryClient.byInstallation.set(10, [repo(2, "alice/two")]);
  const resync = await state.app(post("/api/github/repositories/sync", state.session.token, {}));
  assert.equal(resync.status, 200);
  assert.equal((await resync.json()).length, 1);
  assert.equal(await state.repositoryStore.authorizeAgentRepository(state.identity.userId, 1), null);

  const staleEnable = await state.app(post("/api/github/repositories/1/agent-access", state.session.token, { enabled: true }));
  assert.equal(staleEnable.status, 404);
});

test("sync requests reconnection for unavailable installations and revokes stale repository access", async () => {
  const state = await runtime();
  await state.app(post("/api/github/repositories/sync", state.session.token, {}));
  await state.repositoryStore.setAgentEnabled(state.identity.userId, 1, true);
  state.repositoryClient.listInstallationRepositories = async () => { throw new Error("GITHUB_INSTALLATION_UNAVAILABLE"); };
  const response = await state.app(post("/api/github/repositories/sync", state.session.token, {}));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "GITHUB_CONNECTION_REQUIRED");
  assert.deepEqual(await state.repositoryStore.listForUser(state.identity.userId), []);
  assert.equal(await state.repositoryStore.authorizeAgentRepository(state.identity.userId, 1), null);
});

test("repository API is isolated between authenticated users", async () => {
  const state = await runtime();
  await state.app(post("/api/github/repositories/sync", state.session.token, {}));

  const auth = new MemoryAuthStore();
  const bob = await auth.bindGitHubUser({ id: 200, login: "bob" });
  const bobSession = await auth.createSession(bob.userId);
  const app = createChatApp(
    new MemoryChatStore(),
    new DemoChatProvider(),
    true,
    3000,
    { store: auth, github: new FakeOAuth() },
    "http://localhost:3000",
    {
      slug: "journey-harness",
      store: new MemoryGitHubInstallationStore(),
      verifier: new NoopVerifier(),
      repositoryStore: state.repositoryStore,
      repositoryClient: state.repositoryClient,
    },
  );
  const response = await app(post("/api/github/repositories/1/agent-access", bobSession.token, { enabled: true }));
  assert.equal(response.status, 404);
});

test("Mongo repository store preserves IDs and disables removed access", { skip: !process.env.MONGODB_TEST_URI }, async () => {
  const client = new MongoClient(process.env.MONGODB_TEST_URI!);
  await client.connect();
  const database = client.db(`journey_harness_repo_test_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    const store = new MongoConnectedRepositoryStore(database.collection<ConnectedRepository>("connected_repositories"));
    await store.init();
    await store.syncInstallation("alice", 10, [repo(7, "org/project")]);
    assert.equal((await store.setAgentEnabled("alice", 7, true))?.agentEnabled, true);
    assert.equal((await store.authorizeAgentRepository("alice", 7))?.repositoryId, 7);
    assert.equal(await store.authorizeAgentRepository("bob", 7), null);

    await store.syncInstallation("alice", 10, []);
    assert.equal(await store.authorizeAgentRepository("alice", 7), null);
    const raw = await database.collection<ConnectedRepository>("connected_repositories").findOne({ repositoryId: 7, connectedByUserId: "alice" });
    assert.equal(raw?.connected, false);
    assert.equal(raw?.agentEnabled, false);
  } finally {
    await database.dropDatabase();
    await client.close();
  }
});
