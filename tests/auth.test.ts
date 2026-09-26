import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";
import type { GitHubOAuthClient } from "../src/auth/github.js";
import { MemoryAuthStore, MongoAuthStore, type AuthSession, type GitHubIdentity, type GitHubProfile, type OAuthState } from "../src/auth/store.js";
import { createChatApp } from "../src/chat/app.js";
import { DemoChatProvider } from "../src/chat/provider.js";
import { MemoryChatStore } from "../src/chat/store.js";
import type { PlatformUser } from "../src/models.js";

class FakeGitHub implements GitHubOAuthClient {
  profile: GitHubProfile = { id: 12345, login: "octocat", name: "Octo Cat", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" };
  authorizationUrl(state: string) { return `https://github.example/authorize?state=${encodeURIComponent(state)}`; }
  async exchangeCode(code: string) {
    if (code !== "good-code") throw new Error("bad code");
    return this.profile;
  }
}

function cookieValue(response: Response, name: string) {
  const header = response.headers.get("set-cookie") || "";
  return new RegExp(`${name}=([^;,\\s]+)`).exec(header)?.[1];
}

async function beginLogin(app: ReturnType<typeof createChatApp>, origin = "http://localhost:3000") {
  const response = await app(new Request(`${origin}/auth/github`));
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  const state = new URL(location).searchParams.get("state");
  const stateCookie = cookieValue(response, "journey_oauth_state");
  assert.ok(state && stateCookie);
  assert.equal(state, stateCookie);
  return { state, stateCookie };
}

async function finishLogin(app: ReturnType<typeof createChatApp>, state: string, stateCookie: string, origin = "http://localhost:3000") {
  return app(new Request(`${origin}/auth/github/callback?code=good-code&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `journey_oauth_state=${stateCookie}` },
  }));
}

test("GitHub login validates state, creates a session, preserves userId across login changes, and logs out", async () => {
  const authStore = new MemoryAuthStore();
  const github = new FakeGitHub();
  const app = createChatApp(new MemoryChatStore(), new DemoChatProvider(), true, 3000, { store: authStore, github });

  assert.equal((await app(new Request("http://localhost:3000/api/chats"))).status, 401);

  const invalid = await beginLogin(app);
  const invalidCallback = await app(new Request("http://localhost:3000/auth/github/callback?code=good-code&state=wrong", {
    headers: { cookie: `journey_oauth_state=${invalid.stateCookie}` },
  }));
  assert.equal(invalidCallback.status, 400);

  const first = await beginLogin(app);
  const firstCallback = await finishLogin(app, first.state, first.stateCookie);
  assert.equal(firstCallback.status, 302);
  const firstSession = cookieValue(firstCallback, "journey_session");
  assert.ok(firstSession);

  const me = await app(new Request("http://localhost:3000/api/me", { headers: { cookie: `journey_session=${firstSession}` } }));
  assert.equal(me.status, 200);
  const firstUser = await me.json();
  assert.equal(firstUser.githubUserId, 12345);
  assert.equal(firstUser.githubLogin, "octocat");

  const chat = await app(new Request("http://localhost:3000/api/chats", {
    method: "POST",
    headers: { cookie: `journey_session=${firstSession}`, origin: "http://localhost:3000", "content-type": "application/json" },
    body: "{}",
  }));
  assert.equal(chat.status, 201);

  github.profile = { ...github.profile, login: "renamed-octocat" };
  const second = await beginLogin(app);
  const secondCallback = await finishLogin(app, second.state, second.stateCookie);
  const secondSession = cookieValue(secondCallback, "journey_session");
  assert.ok(secondSession);
  const secondMe = await app(new Request("http://localhost:3000/api/me", { headers: { cookie: `journey_session=${secondSession}` } }));
  const secondUser = await secondMe.json();
  assert.equal(secondUser.userId, firstUser.userId);
  assert.equal(secondUser.githubLogin, "renamed-octocat");

  const logout = await app(new Request("http://localhost:3000/auth/logout", {
    method: "POST",
    headers: { cookie: `journey_session=${secondSession}`, origin: "http://localhost:3000", "content-type": "application/json" },
    body: "{}",
  }));
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") || "", /journey_session=;/);
  assert.equal((await app(new Request("http://localhost:3000/api/me", { headers: { cookie: `journey_session=${secondSession}` } }))).status, 401);
});

test("production auth cookies are Secure", async () => {
  const app = createChatApp(new MemoryChatStore(), new DemoChatProvider(), true, 443, {
    store: new MemoryAuthStore(), github: new FakeGitHub(), secureCookies: true,
  }, "https://app.example");
  const response = await app(new Request("https://app.example/auth/github"));
  assert.equal(response.status, 302);
  assert.match(response.headers.get("set-cookie") || "", /; Secure/);
});

test("Mongo auth binding is stable and sessions resolve server-side", { skip: !process.env.MONGODB_TEST_URI }, async () => {
  const client = new MongoClient(process.env.MONGODB_TEST_URI!);
  await client.connect();
  const database = client.db(`journey_harness_auth_test_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    const store = new MongoAuthStore(
      database.collection<PlatformUser>("users"),
      database.collection<GitHubIdentity>("github_identities"),
      database.collection<AuthSession>("auth_sessions"),
      database.collection<OAuthState>("oauth_states"),
    );
    await store.init();
    const first = await store.bindGitHubUser({ id: 77, login: "first" });
    const second = await store.bindGitHubUser({ id: 77, login: "second" });
    assert.equal(second.userId, first.userId);
    assert.equal(second.githubLogin, "second");
    assert.equal(await database.collection("github_identities").countDocuments({ githubUserId: 77 }), 1);
    assert.equal(await database.collection("users").countDocuments({ userId: first.userId }), 1);
    const session = await store.createSession(first.userId);
    assert.equal((await store.resolveSession(session.token))?.userId, first.userId);
    assert.equal(await database.collection("auth_sessions").countDocuments({ userId: first.userId }), 1);
    assert.equal(await database.collection("auth_sessions").findOne({ userId: first.userId, tokenHash: session.token }), null);
  } finally {
    await database.dropDatabase();
    await client.close();
  }
});
