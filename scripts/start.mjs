import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { health, opencodeBinary, root, runtimeEnvironment, serverSettings, stop } from "./runtime.mjs";

let opencode;
let app;
let stopping = false;
let cleanup;
function shutdown(code) {
  stopping = true;
  process.exitCode = code;
  return cleanup ||= Promise.all([stop(app), stop(opencode)]);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void shutdown(0); });

async function main() {
  if (!process.env.MONGODB_URI?.trim()) throw new Error("Set MONGODB_URI in .env before starting the app.");
  const env = runtimeEnvironment();
  const settings = serverSettings(env);
  if (!await health(settings)) {
    const host = settings.url.hostname.replace(/^\[|\]$/g, "");
    if (settings.url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
      throw new Error("The configured remote OpenCode server is unavailable. Start it or correct OPENCODE_URL.");
    }
    if (stopping) return;
    console.log("Starting the project-local OpenCode server…");
    opencode = spawn(opencodeBinary(), ["serve", "--hostname", host, "--port", settings.url.port || "80"], {
      cwd: root, env, stdio: "inherit", shell: false,
    });
    let startError = false;
    opencode.once("error", () => { startError = true; });
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline && !stopping) {
      if (startError || opencode.exitCode !== null || opencode.signalCode !== null) throw new Error("OpenCode exited before becoming ready. Check whether the port is already in use.");
      if (await health(settings)) { ready = true; break; }
      await delay(250);
    }
    if (stopping) return;
    if (!ready) throw new Error("OpenCode did not become ready within 30 seconds.");
  } else {
    console.log("Using the configured OpenCode server.");
  }
  if (stopping) return;
  console.log(`Starting Journey Harness with ${env.OPENCODE_MODEL}`);
  app = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env, stdio: "inherit", shell: false });
  app.once("error", () => { console.error("Cannot start the app. Run npm install."); void shutdown(1); });
  app.once("close", code => { if (!stopping) void shutdown(code ?? 1); });
  opencode?.once("close", () => {
    if (!stopping) { console.error("OpenCode stopped unexpectedly."); void shutdown(1); }
  });
}

main().catch(async error => {
  console.error(error.message);
  await shutdown(1);
});
