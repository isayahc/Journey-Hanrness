import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { MongoClient } from "mongodb";
import { health, opencodeBinary, root, runtimeEnvironment, serverSettings, stop } from "../scripts/runtime.mjs";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(check, description) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(200);
  }
  assert.fail(description);
}

test("startup serves the app and stops only its owned OpenCode process", {
  skip: !process.env.MONGODB_TEST_URI,
  timeout: 75_000,
}, async () => {
  const database = `journey_startup_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await new MongoClient(process.env.MONGODB_TEST_URI, { serverSelectionTimeoutMS: 5000 }).connect();
  let supervisor;
  let external;
  try {
    const port = await freePort();
    const env = runtimeEnvironment({ ...process.env,
      MONGODB_URI: process.env.MONGODB_TEST_URI, MONGODB_DB: database,
      PORT: String(port), APP_ORIGIN: `http://127.0.0.1:${port}`,
      OPENCODE_URL: `http://127.0.0.1:${await freePort()}`,
      OPENCODE_SERVER_PASSWORD: "test-startup-password", OPENCODE_SERVER_USERNAME: "opencode",
      GITHUB_APP_CLIENT_ID: "", GITHUB_APP_CLIENT_SECRET: "", GITHUB_APP_SLUG: "",
    });
    const settings = serverSettings(env);
    const startApp = async () => {
      supervisor = spawn(process.execPath, ["--env-file-if-exists=.env", "scripts/start.mjs"], { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });
      let startError;
      supervisor.once("error", error => { startError = error; });
      await until(async () => {
        if (startError) throw startError;
        assert.equal(supervisor.exitCode, null, "Supervisor exited during startup");
        try {
          const response = await fetch(`${env.APP_ORIGIN}/api/status`, { signal: AbortSignal.timeout(500) });
          return response.ok && (await response.json()).demo === false;
        } catch { return false; }
      }, "App did not become ready");
      assert.match(await (await fetch(env.APP_ORIGIN, { signal: AbortSignal.timeout(2000) })).text(), /Journey Harness/);
    };
    console.info("Startup smoke: managed service");
    await startApp();
    assert.equal(await health(settings), true);
    console.info("Startup smoke: stopping managed service");
    await stop(supervisor);
    await until(async () => !await health(settings), "Owned OpenCode process was left running");
    console.info("Startup smoke: external service");
    external = spawn(opencodeBinary(), ["serve", "--hostname", "127.0.0.1", "--port", settings.url.port], { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });
    external.once("error", () => {});
    await until(() => health(settings), "External OpenCode process did not become ready");
    await startApp();
    await stop(supervisor);
    assert.equal(await health(settings), true, "Reused OpenCode process must remain running");
  } finally {
    console.info("Startup smoke: cleanup");
    await stop(supervisor);
    await stop(external);
    await client.db(database).dropDatabase();
    await client.close();
  }
});
