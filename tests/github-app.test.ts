import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";
import type { GitHubInstallationVerifier, VerifiedGitHubInstallation } from "../src/auth/github.js";
import { MemoryAuthStore } from "../src/auth/store.js";
import { createChatApp } from "../src/chat/app.js";
import { MemoryConnectedRepositoryStore } from "../src/github/repositories.js";
import { DemoChatProvider } from "../src/chat/provider.js";
import { MemoryChatStore } from "../src/chat/store.js";
import {
  MemoryGitHubInstallationStore,
  MongoGitHubInstallationStore,
  type GitHubInstallationLink,
  type GitHubInstallationState,
} from "../src/github/installations.js";

class FakeOAuth {
  authorizationUrl(state: string) { return `https://github.example/login?state=${encodeURIComponent(state)}`; }
  async exchangeCode() { return { id: 100, login: "alice" }; }
}

class FakeVerifier implements GitHubInstallationVerifier {
  profileId = 100;
  installation: VerifiedGitHubInstallation | null = {
    installationId: 42,
    accountId: 900,
    accountLogin: "example-org",
    accountType: "Organization",
    repositorySelection: "selected",
    permissions: { metadata: "read", contents: "write", pull_requests: "write" },
  };

  installationAuthorizationUrl(state: string, callbackUrl: string) {
    const url = new URL("https://github.example/verify");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", callbackUrl);
    return url.toString();
  }

  async verifyInstallationCode(_code: string, _callbackUrl: string, installationId: number) {
    return {
      profile: { id: this.profileId, login: this.profileId === 100 ? "alice" : "someone-else" },
      installation: this.installation?.installationId === installationId ? this.installation : null,
    };
  }
}

async function authenticatedRuntime() {
  const auth = new MemoryAuthStore();
  const identity = await auth.bindGitHubUser({ id: 100, login: "alice" });
  const session = await auth.createSession(identity.userId);
  const installations = new MemoryGitHubInstallationStore();
  const verifier = new FakeVerifier();
  return {
    identity,
    session,
    verifier,
    installations,
    app: createChatApp(
      new MemoryChatStore(),
      new DemoChatProvider(),
      true,
      3000,
      { store: auth, github: new FakeOAuth() },
      "http://localhost:3000",
      { slug: "journey-harness", store: installations, verifier, repositoryStore: new MemoryConnectedRepositoryStore() },
    ),
  };
}

function sessionHeaders(token: string) {
  return { cookie: `journey_session=${token}` };
}

function cookieValue(response: Response, name: string) {
  const header = response.headers.get("set-cookie") || "";
  return new RegExp(`${name}=([^;,\\s]+)`).exec(header)?.[1];
}

test("signed-in users can install and verify an organization GitHub App installation", async () => {
  const runtime = await authenticatedRuntime();

  const install = await runtime.app(new Request("http://localhost:3000/github/install", {
    headers: sessionHeaders(runtime.session.token),
  }));
  assert.equal(install.status, 302);
  assert.equal(install.headers.get("location"), "https://github.com/apps/journey-harness/installations/new");

  const setup = await runtime.app(new Request("http://localhost:3000/github/setup?installation_id=42&setup_action=install", {
    headers: sessionHeaders(runtime.session.token),
  }));
  assert.equal(setup.status, 302);
  const verificationUrl = new URL(setup.headers.get("location")!);
  const state = verificationUrl.searchParams.get("state");
  const stateCookie = cookieValue(setup, "journey_install_state");
  assert.ok(state && stateCookie);
  assert.equal(state, stateCookie);
  assert.equal(verificationUrl.searchParams.get("redirect_uri"), "http://localhost:3000/github/setup/callback");

  const callback = await runtime.app(new Request(
    `http://localhost:3000/github/setup/callback?code=verify-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `journey_session=${runtime.session.token}; journey_install_state=${stateCookie}` } },
  ));
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/?github=connected");

  const list = await runtime.app(new Request("http://localhost:3000/api/github/installations", {
    headers: sessionHeaders(runtime.session.token),
  }));
  assert.equal(list.status, 200);
  const saved = await list.json();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].installationId, 42);
  assert.equal(saved[0].accountType, "Organization");
  assert.equal(saved[0].accountLogin, "example-org");
});

test("spoofed installation IDs, account mismatch, and insufficient permissions are rejected", async () => {
  const spoof = await authenticatedRuntime();
  const spoofSetup = await spoof.app(new Request("http://localhost:3000/github/setup?installation_id=99", {
    headers: sessionHeaders(spoof.session.token),
  }));
  const spoofState = new URL(spoofSetup.headers.get("location")!).searchParams.get("state")!;
  const spoofCookie = cookieValue(spoofSetup, "journey_install_state")!;
  const spoofCallback = await spoof.app(new Request(
    `http://localhost:3000/github/setup/callback?code=verify-code&state=${encodeURIComponent(spoofState)}`,
    { headers: { cookie: `journey_session=${spoof.session.token}; journey_install_state=${spoofCookie}` } },
  ));
  assert.equal(spoofCallback.headers.get("location"), "/?github=unauthorized");
  assert.equal((await spoof.installations.listForUser(spoof.identity.userId)).length, 0);

  const mismatch = await authenticatedRuntime();
  mismatch.verifier.profileId = 101;
  const mismatchSetup = await mismatch.app(new Request("http://localhost:3000/github/setup?installation_id=42", {
    headers: sessionHeaders(mismatch.session.token),
  }));
  const mismatchState = new URL(mismatchSetup.headers.get("location")!).searchParams.get("state")!;
  const mismatchCookie = cookieValue(mismatchSetup, "journey_install_state")!;
  const mismatchCallback = await mismatch.app(new Request(
    `http://localhost:3000/github/setup/callback?code=verify-code&state=${encodeURIComponent(mismatchState)}`,
    { headers: { cookie: `journey_session=${mismatch.session.token}; journey_install_state=${mismatchCookie}` } },
  ));
  assert.equal(mismatchCallback.headers.get("location"), "/?github=account-mismatch");

  const permissions = await authenticatedRuntime();
  permissions.verifier.installation = {
    ...permissions.verifier.installation!,
    permissions: { metadata: "read", contents: "read", pull_requests: "write" },
  };
  const permissionSetup = await permissions.app(new Request("http://localhost:3000/github/setup?installation_id=42", {
    headers: sessionHeaders(permissions.session.token),
  }));
  const permissionState = new URL(permissionSetup.headers.get("location")!).searchParams.get("state")!;
  const permissionCookie = cookieValue(permissionSetup, "journey_install_state")!;
  const permissionCallback = await permissions.app(new Request(
    `http://localhost:3000/github/setup/callback?code=verify-code&state=${encodeURIComponent(permissionState)}`,
    { headers: { cookie: `journey_session=${permissions.session.token}; journey_install_state=${permissionCookie}` } },
  ));
  assert.equal(permissionCallback.headers.get("location"), "/?github=permissions");
});

test("installation verification state is bound to the authenticated journey-harness user", async () => {
  const auth = new MemoryAuthStore();
  const alice = await auth.bindGitHubUser({ id: 100, login: "alice" });
  const bob = await auth.bindGitHubUser({ id: 200, login: "bob" });
  const aliceSession = await auth.createSession(alice.userId);
  const bobSession = await auth.createSession(bob.userId);
  const installationStore = new MemoryGitHubInstallationStore();
  const app = createChatApp(
    new MemoryChatStore(),
    new DemoChatProvider(),
    true,
    3000,
    { store: auth, github: new FakeOAuth() },
    "http://localhost:3000",
    { slug: "journey-harness", store: installationStore, verifier: new FakeVerifier(), repositoryStore: new MemoryConnectedRepositoryStore() },
  );

  const setup = await app(new Request("http://localhost:3000/github/setup?installation_id=42", {
    headers: sessionHeaders(aliceSession.token),
  }));
  const state = new URL(setup.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = cookieValue(setup, "journey_install_state")!;
  const stolen = await app(new Request(
    `http://localhost:3000/github/setup/callback?code=verify-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `journey_session=${bobSession.token}; journey_install_state=${stateCookie}` } },
  ));
  assert.equal(stolen.status, 400);
  assert.equal((await installationStore.listForUser(alice.userId)).length, 0);
  assert.equal((await installationStore.listForUser(bob.userId)).length, 0);
});

test("organization install requests return a useful pending state", async () => {
  const runtime = await authenticatedRuntime();
  const response = await runtime.app(new Request("http://localhost:3000/github/setup?setup_action=request", {
    headers: sessionHeaders(runtime.session.token),
  }));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/?github=requested");
});

test("Mongo installation store persists verified links and one-time state", { skip: !process.env.MONGODB_TEST_URI }, async () => {
  const client = new MongoClient(process.env.MONGODB_TEST_URI!);
  await client.connect();
  const database = client.db(`journey_harness_install_test_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    const store = new MongoGitHubInstallationStore(
      database.collection<GitHubInstallationLink>("github_installations"),
      database.collection<GitHubInstallationState>("github_installation_states"),
    );
    await store.init();
    const state = await store.createVerificationState("user-a", 42);
    assert.equal(await store.consumeVerificationState(state, state, "user-b"), null);
    assert.equal(await store.consumeVerificationState(state, state, "user-a"), 42);
    assert.equal(await store.consumeVerificationState(state, state, "user-a"), null);

    await store.linkInstallation("user-a", {
      installationId: 42,
      accountId: 900,
      accountLogin: "example-org",
      accountType: "Organization",
      repositorySelection: "selected",
      permissions: { metadata: "read", contents: "write", pull_requests: "write" },
    });
    const saved = await store.listForUser("user-a");
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.accountLogin, "example-org");
    assert.equal(await store.listForUser("user-b").then(items => items.length), 0);
  } finally {
    await database.dropDatabase();
    await client.close();
  }
});
