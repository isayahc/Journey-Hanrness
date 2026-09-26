import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { MongoClient } from "mongodb";
import { MemoryGitHubInstallationStore } from "../src/github/installations.js";
import { MemoryConnectedRepositoryStore, type ConnectedRepository } from "../src/github/repositories.js";
import {
  handleGitHubWebhook,
  MemoryGitHubWebhookDeliveryStore,
  MongoGitHubWebhookDeliveryStore,
  type GitHubWebhookDelivery,
  verifyGitHubWebhookSignature,
} from "../src/github/webhooks.js";
import type { GitHubAppRepositoryClient } from "../src/github/app-client.js";

function sign(secret: string, body: string) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function request(event: string, delivery: string, payload: unknown, secret = "secret") {
  const body = JSON.stringify(payload);
  return new Request("http://localhost:3000/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": sign(secret, body),
    },
    body,
  });
}

test("signature verification matches GitHub's published test vector", () => {
  const body = new TextEncoder().encode("Hello, World!");
  assert.equal(
    verifyGitHubWebhookSignature(
      "It's a Secret to Everybody",
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      body,
    ),
    true,
  );
  assert.equal(verifyGitHubWebhookSignature("wrong", "sha256=deadbeef", body), false);
});

async function seeded() {
  const installationStore = new MemoryGitHubInstallationStore();
  const repositoryStore = new MemoryConnectedRepositoryStore();
  const deliveries = new MemoryGitHubWebhookDeliveryStore();
  const alice = "alice-user";
  const bob = "bob-user";
  await installationStore.linkInstallation(alice, {
    installationId: 42,
    accountId: 1,
    accountLogin: "org",
    accountType: "Organization",
    repositorySelection: "selected",
    permissions: { metadata: "read", contents: "write", pull_requests: "write" },
  });
  await installationStore.linkInstallation(bob, {
    installationId: 42,
    accountId: 1,
    accountLogin: "org",
    accountType: "Organization",
    repositorySelection: "selected",
    permissions: { metadata: "read", contents: "write", pull_requests: "write" },
  });
  const repos = [
    { repositoryId: 100, fullName: "org/one", defaultBranch: "main", private: true, archived: false },
    { repositoryId: 200, fullName: "org/two", defaultBranch: "main", private: true, archived: false },
  ];
  await repositoryStore.syncInstallation(alice, 42, repos);
  await repositoryStore.syncInstallation(bob, 42, repos);
  await repositoryStore.setAgentEnabled(alice, 100, true);
  await repositoryStore.setAgentEnabled(bob, 100, true);
  return { installationStore, repositoryStore, deliveries, alice, bob };
}

test("invalid webhook signatures are rejected before state changes", async () => {
  const state = await seeded();
  const body = JSON.stringify({ action: "deleted", installation: { id: 42 } });
  const response = await handleGitHubWebhook(
    { secret: "secret", deliveries: state.deliveries, installationStore: state.installationStore, repositoryStore: state.repositoryStore },
    new Request("http://localhost:3000/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "installation",
        "x-github-delivery": "bad-signature",
        "x-hub-signature-256": "sha256=bad",
      },
      body,
    }),
  );
  assert.equal(response.status, 401);
  assert.ok(await state.repositoryStore.authorizeAgentRepository(state.alice, 100));
});

test("repository removal disables access for every linked user and duplicate delivery is idempotent", async () => {
  const state = await seeded();
  const runtime = { secret: "secret", deliveries: state.deliveries, installationStore: state.installationStore, repositoryStore: state.repositoryStore };
  const payload = {
    action: "removed",
    installation: { id: 42 },
    repositories_added: [],
    repositories_removed: [{ id: 100 }],
    repository_selection: "selected",
  };
  const first = await handleGitHubWebhook(runtime, request("installation_repositories", "delivery-1", payload));
  assert.equal(first.status, 202);
  assert.equal(await state.repositoryStore.authorizeAgentRepository(state.alice, 100), null);
  assert.equal(await state.repositoryStore.authorizeAgentRepository(state.bob, 100), null);

  const second = await handleGitHubWebhook(runtime, request("installation_repositories", "delivery-1", payload));
  assert.equal(second.status, 202);
  assert.equal((await second.json()).duplicate, true);
});

test("suspend and delete immediately disable installation repositories", async () => {
  const suspended = await seeded();
  const suspendResponse = await handleGitHubWebhook(
    { secret: "secret", deliveries: suspended.deliveries, installationStore: suspended.installationStore, repositoryStore: suspended.repositoryStore },
    request("installation", "delivery-suspend", { action: "suspend", installation: { id: 42 } }),
  );
  assert.equal(suspendResponse.status, 202);
  assert.equal((await suspended.installationStore.listForUser(suspended.alice)).length, 0);
  assert.equal(await suspended.repositoryStore.authorizeAgentRepository(suspended.alice, 100), null);

  const deleted = await seeded();
  const deleteResponse = await handleGitHubWebhook(
    { secret: "secret", deliveries: deleted.deliveries, installationStore: deleted.installationStore, repositoryStore: deleted.repositoryStore },
    request("installation", "delivery-delete", { action: "deleted", installation: { id: 42 } }),
  );
  assert.equal(deleteResponse.status, 202);
  assert.equal((await deleted.installationStore.listForUser(deleted.alice)).length, 0);
  assert.equal(await deleted.repositoryStore.authorizeAgentRepository(deleted.alice, 100), null);
});

test("unsuspend reconciles repositories but does not silently restore agent enablement", async () => {
  const state = await seeded();
  const client: GitHubAppRepositoryClient = {
    async listInstallationRepositories() {
      return [{ repositoryId: 100, fullName: "org/one", defaultBranch: "main", private: true, archived: false }];
    },
  };
  const runtime = {
    secret: "secret",
    deliveries: state.deliveries,
    installationStore: state.installationStore,
    repositoryStore: state.repositoryStore,
    repositoryClient: client,
  };
  await handleGitHubWebhook(runtime, request("installation", "delivery-s1", { action: "suspend", installation: { id: 42 } }));
  await handleGitHubWebhook(runtime, request("installation", "delivery-u1", { action: "unsuspend", installation: { id: 42 } }));

  const repos = await state.repositoryStore.listForUser(state.alice);
  assert.equal(repos.length, 1);
  assert.equal(repos[0]?.repositoryId, 100);
  assert.equal(repos[0]?.agentEnabled, false);
  assert.equal(await state.repositoryStore.authorizeAgentRepository(state.alice, 100), null);
});

test("failed deliveries are released so a redelivery can retry", async () => {
  const state = await seeded();
  const failingClient: GitHubAppRepositoryClient = {
    async listInstallationRepositories() { throw new Error("temporary failure"); },
  };
  const runtime = {
    secret: "secret",
    deliveries: state.deliveries,
    installationStore: state.installationStore,
    repositoryStore: state.repositoryStore,
    repositoryClient: failingClient,
  };
  const payload = { action: "added", installation: { id: 42 }, repositories_added: [{ id: 300 }], repositories_removed: [], repository_selection: "selected" };
  const first = await handleGitHubWebhook(runtime, request("installation_repositories", "retry-me", payload));
  assert.equal(first.status, 500);

  const goodRuntime = { ...runtime, repositoryClient: { async listInstallationRepositories() { return []; } } };
  const second = await handleGitHubWebhook(goodRuntime, request("installation_repositories", "retry-me", payload));
  assert.equal(second.status, 202);
  assert.equal((await second.json()).duplicate, undefined);
});

test("Mongo delivery store claims each delivery once", { skip: !process.env.MONGODB_TEST_URI }, async () => {
  const client = new MongoClient(process.env.MONGODB_TEST_URI!);
  await client.connect();
  const database = client.db(`journey_harness_webhook_test_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    const store = new MongoGitHubWebhookDeliveryStore(database.collection<GitHubWebhookDelivery>("github_webhook_deliveries"));
    await store.init();
    assert.equal(await store.claim("abc", "installation"), true);
    assert.equal(await store.claim("abc", "installation"), false);
    await store.complete("abc");
    const record = await database.collection<GitHubWebhookDelivery>("github_webhook_deliveries").findOne({ deliveryId: "abc" });
    assert.ok(record?.processedAt);
    await store.release("abc");
    assert.equal(await store.claim("abc", "installation"), true);
  } finally {
    await database.dropDatabase();
    await client.close();
  }
});
