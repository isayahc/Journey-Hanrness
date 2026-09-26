import assert from "node:assert/strict";
import test from "node:test";
import { GitHubOAuth } from "../src/auth/github.js";

const installation = (id: number) => ({
  id, app_slug: "journey-harness", account: { id: 100, login: "alice", type: "User" },
  repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write" },
  suspended_at: null as string | null,
});
function oauth(pages: ReturnType<typeof installation>[][], status = 200) {
  const calls: Request[] = [];
  const request: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push(req);
    if (req.url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "ephemeral-user-token" });
    assert.equal(req.headers.get("authorization"), "Bearer ephemeral-user-token");
    if (req.url === "https://api.github.com/user") return Response.json({ id: 100, login: "alice" });
    assert.equal(new URL(req.url).pathname, "/user/installations");
    const page = Number(new URL(req.url).searchParams.get("page"));
    return Response.json({ total_count: pages.flat().length, installations: pages[page - 1] || [] }, { status });
  };
  return { client: new GitHubOAuth("client-id", "client-secret", "http://localhost:3000/auth/github/callback", request), calls };
}

test("GitHub recovery discovers all accessible active installations with a temporary user token", async () => {
  const suspended = { ...installation(101), suspended_at: "2026-09-26T00:00:00Z" };
  const { client, calls } = oauth([Array.from({ length: 100 }, (_, i) => installation(i + 1)), [suspended, installation(102)]]);
  const verified = await client.verifyInstallationCode("code", "http://localhost:3000/github/setup/callback", null, "journey-harness");
  assert.equal(verified.profile.id, 100);
  assert.equal(verified.installations.length, 101);
  assert.equal(verified.installations.at(-1)?.installationId, 102);
  assert.equal(calls.length, 4);
  const exchange = new URLSearchParams(await calls[0]!.text());
  assert.equal(exchange.get("redirect_uri"), "http://localhost:3000/github/setup/callback");
  assert.equal(JSON.stringify(verified).includes("ephemeral-user-token"), false);
});

test("setup verification selects only the requested installation and excludes suspended access", async () => {
  const { client } = oauth([[installation(42), { ...installation(43), suspended_at: "2026-09-26" }]]);
  assert.deepEqual((await client.verifyInstallationCode("code", "callback", 42, "journey-harness")).installations.map(item => item.installationId), [42]);
  assert.deepEqual((await client.verifyInstallationCode("code", "callback", 43, "journey-harness")).installations, []);
  assert.deepEqual((await client.verifyInstallationCode("code", "callback", 99, "journey-harness")).installations, []);
});

test("discovery fails closed for mismatched app credentials or failed GitHub access", async () => {
  const mismatch = oauth([[{ ...installation(42), app_slug: "different-app" }]]);
  await assert.rejects(mismatch.client.verifyInstallationCode("code", "callback", null, "journey-harness"), /credentials do not match/);
  const denied = oauth([[]], 403);
  await assert.rejects(denied.client.verifyInstallationCode("code", "callback", null, "journey-harness"), /installation lookup failed/);
});
