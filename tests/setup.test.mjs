import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { setup } from "../scripts/setup.mjs";
import { health, opencodeBinary, runtimeEnvironment, serverSettings, stop } from "../scripts/runtime.mjs";

test("npm setup creates configuration once and preserves user changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "journey-setup-"));
  const root = pathToFileURL(directory + "/");
  try {
    await writeFile(join(directory, ".env.example"), "OPENCODE_MODEL=opencode/space-bunny-free\n");
    assert.equal(await setup(root), true);
    assert.match(await readFile(join(directory, ".env"), "utf8"), /space-bunny-free/);
    await writeFile(join(directory, ".env"), "MONGODB_URI=user-controlled\n");
    assert.equal(await setup(root), false);
    assert.equal(await readFile(join(directory, ".env"), "utf8"), "MONGODB_URI=user-controlled\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("runtime defaults, explicit overrides, and health authentication stay consistent", async () => {
  assert.equal(runtimeEnvironment({}).OPENCODE_MODEL, "opencode/space-bunny-free");
  assert.equal(runtimeEnvironment({ OPENCODE_MODEL: "  " }).OPENCODE_MODEL, "opencode/space-bunny-free");
  const env = runtimeEnvironment({ OPENCODE_MODEL: "custom/model", OPENCODE_CONFIG_CONTENT: '{"share":"disabled"}' });
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), { share: "disabled", model: "custom/model" });
  const openRouter = runtimeEnvironment({ OPENROUTER_API_KEY: "test-only" });
  assert.equal(JSON.parse(openRouter.OPENCODE_CONFIG_CONTENT).provider.openrouter.options.apiKey, "{env:OPENROUTER_API_KEY}");
  assert.equal(openRouter.OPENCODE_MODEL, "opencode/space-bunny-free");
  assert.throws(() => runtimeEnvironment({ OPENCODE_MODEL: "invalid" }), /provider\/model/);
  const settings = serverSettings({ OPENCODE_URL: "http://127.0.0.1:4500", OPENCODE_SERVER_PASSWORD: "test-only", OPENCODE_SERVER_USERNAME: "operator" });
  assert.equal(await health(settings, async (url, options) => {
    assert.equal(url.href, "http://127.0.0.1:4500/global/health");
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from("operator:test-only").toString("base64")}`);
    return Response.json({ healthy: true, version: "test" });
  }), true);
  assert.equal(await health(settings, async () => Response.json({ ok: true })), false);
  await assert.rejects(health(settings, async () => new Response(null, { status: 401 })), /authentication failed/);
  assert.throws(() => serverSettings({ OPENCODE_URL: "http://user:pass@localhost:4096" }), /without credentials/);
});

test("npm-installed OpenCode starts a real authenticated server and shuts down", { timeout: 45_000 }, async () => {
  const binary = opencodeBinary();
  assert.match(execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 }), /^1\.18\.32\s*$/);
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const environment = runtimeEnvironment({ ...process.env,
    OPENCODE_URL: `http://127.0.0.1:${port}`,
    OPENCODE_SERVER_PASSWORD: "journey-test-password", OPENCODE_SERVER_USERNAME: "opencode",
  });
  const settings = serverSettings(environment);
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { env: environment, stdio: "ignore", shell: false });
  let spawnError;
  child.once("error", error => { spawnError = error; });
  try {
    const deadline = Date.now() + 25_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, "OpenCode exited during startup");
      if (await health(settings)) { ready = true; break; }
      await delay(200);
    }
    assert.equal(ready, true, "OpenCode did not report healthy");
  } finally { await stop(child); }
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
