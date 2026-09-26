import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

export const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

export function opencodeBinary() {
  const path = require.resolve("opencode-ai/package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const binary = resolve(dirname(path), typeof manifest.bin === "string" ? manifest.bin : manifest.bin.opencode);
  if (!existsSync(binary)) throw new Error("OpenCode is missing. Run npm install with lifecycle scripts enabled.");
  return binary;
}

export function runtimeEnvironment(env = process.env) {
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}");
  const model = env.OPENCODE_MODEL?.trim() || "opencode/space-bunny-free";
  if (!/^[^/\s]+\/\S+$/.test(model)) throw new Error("OPENCODE_MODEL must be provider/model");
  return {
    ...env, OPENCODE_MODEL: model, OPENCODE_ENABLE_EXA: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, model }),
  };
}

export function serverSettings(env) {
  const url = new URL(env.OPENCODE_URL || "http://127.0.0.1:4096");
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("OPENCODE_URL must be an HTTP(S) origin without credentials or a path.");
  }
  const headers = env.OPENCODE_SERVER_PASSWORD ? {
    Authorization: `Basic ${Buffer.from(`${env.OPENCODE_SERVER_USERNAME || "opencode"}:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
  } : {};
  return { url, headers };
}

export async function health(settings, fetcher = fetch) {
  try {
    const response = await fetcher(new URL("/global/health", settings.url), {
      headers: settings.headers, signal: AbortSignal.timeout(1000),
    });
    if ([401, 403].includes(response.status)) throw new Error("OpenCode authentication failed. Check the server username and password in .env.");
    if (!response.ok) return false;
    const payload = await response.json();
    return payload.healthy === true && typeof payload.version === "string";
  } catch (error) {
    if (error.message?.startsWith("OpenCode authentication failed")) throw error;
    return false;
  }
}

export async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "exit").catch(() => {});
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  timer.unref();
  try { await closed; } finally { clearTimeout(timer); }
}
