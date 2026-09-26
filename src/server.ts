import { createServer } from "node:http";
import { AgentGitHubCredentialBroker } from "./agents/credential-broker.js";
import { OpenCodeRepositoryAgent } from "./agents/opencode-repository-agent.js";
import { NodeCommandRunner } from "./agents/process-runner.js";
import { AgentRepositoryExecutor } from "./agents/repository-executor.js";
import { MemoryAgentJobAuthorizationStore, MongoAgentJobAuthorizationStore } from "./agents/job-authorizations.js";
import { githubOAuthFromEnv, type GitHubInstallationVerifier } from "./auth/github.js";
import { MemoryAuthStore, MongoAuthStore } from "./auth/store.js";
import { connectDatabase } from "./db.js";
import { MemoryRunStore, MongoRunStore } from "./runs/store.js";
import { DemoRunPlanner, OpenCodeRunPlanner } from "./runs/planner.js";
import { RunService } from "./runs/service.js";
import { createChatApp, type AuthRuntime, type GitHubAppRuntime } from "./chat/app.js";
import { DemoChatProvider, OpenCodeChatProvider } from "./chat/provider.js";
import { MemoryChatStore, MongoChatStore, type Conversation } from "./chat/store.js";
import { githubAppClientFromEnv } from "./github/app-client.js";
import { MemoryGitHubInstallationStore, MongoGitHubInstallationStore } from "./github/installations.js";
import { MemoryConnectedRepositoryStore, MongoConnectedRepositoryStore } from "./github/repositories.js";
import {
  githubWebhookSecretFromEnv,
  MemoryGitHubWebhookDeliveryStore,
  MongoGitHubWebhookDeliveryStore,
} from "./github/webhooks.js";

function githubAppSlug(env: NodeJS.ProcessEnv = process.env) {
  const slug = env.GITHUB_APP_SLUG?.trim();
  if (!slug) return null;
  if (!/^[A-Za-z0-9-]+$/.test(slug)) throw new Error("GITHUB_APP_SLUG must contain only letters, numbers, and hyphens");
  return slug;
}

async function main() {
  const demo = process.argv.includes("--demo");
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
  const appOrigin = process.env.APP_ORIGIN || `http://localhost:${port}`;
  const origin = new URL(appOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.pathname !== "/") throw new Error("APP_ORIGIN must be an http(s) origin without a path");

  const provider = demo ? new DemoChatProvider() : new OpenCodeChatProvider();
  const db = demo ? undefined : await connectDatabase();
  const store = db ? new MongoChatStore(db.database.collection<Conversation>("chat_conversations")) : new MemoryChatStore();
  if (store instanceof MongoChatStore) await store.init();
  const runStore = db ? new MongoRunStore(db.runs) : new MemoryRunStore();
  await runStore.init();
  const runs = new RunService(runStore, demo ? new DemoRunPlanner() : new OpenCodeRunPlanner());

  const github = githubOAuthFromEnv(origin.origin);
  let auth: AuthRuntime | undefined;
  let githubApp: GitHubAppRuntime | undefined;
  if (github) {
    const authStore = db
      ? new MongoAuthStore(db.users, db.githubIdentities, db.authSessions, db.oauthStates)
      : new MemoryAuthStore();
    await authStore.init();
    auth = { store: authStore, github, secureCookies: origin.protocol === "https:" };

    const slug = githubAppSlug();
    if (slug) {
      const installationStore = db
        ? new MongoGitHubInstallationStore(db.githubInstallations, db.githubInstallationStates)
        : new MemoryGitHubInstallationStore();
      const repositoryStore = db
        ? new MongoConnectedRepositoryStore(db.connectedRepositories)
        : new MemoryConnectedRepositoryStore();
      const agentJobStore = db
        ? new MongoAgentJobAuthorizationStore(db.agentJobs)
        : new MemoryAgentJobAuthorizationStore();
      const repositoryClient = githubAppClientFromEnv() || undefined;
      const credentialBroker = repositoryClient
        ? new AgentGitHubCredentialBroker(agentJobStore, repositoryStore, repositoryClient)
        : undefined;
      const executionEnabled = process.env.JOURNEY_AGENT_EXECUTION_ENABLED === "1";
      const repositoryExecutor = executionEnabled && repositoryClient && credentialBroker
        ? new AgentRepositoryExecutor({
            jobs: agentJobStore,
            repositories: repositoryStore,
            github: repositoryClient,
            credentials: credentialBroker,
            commands: new NodeCommandRunner(),
            agent: new OpenCodeRepositoryAgent(),
            workspaceRoot: process.env.JOURNEY_AGENT_WORKSPACE_ROOT,
          })
        : undefined;
      const webhookSecret = githubWebhookSecretFromEnv();
      const webhookDeliveries = db
        ? new MongoGitHubWebhookDeliveryStore(db.githubWebhookDeliveries)
        : new MemoryGitHubWebhookDeliveryStore();
      await Promise.all([
        installationStore.init(),
        repositoryStore.init(),
        agentJobStore.init(),
        webhookDeliveries.init(),
      ]);
      githubApp = {
        slug,
        store: installationStore,
        verifier: github as GitHubInstallationVerifier,
        repositoryStore,
        repositoryClient,
        credentialBroker,
        jobStore: agentJobStore,
        repositoryExecutor,
        webhook: webhookSecret ? {
          secret: webhookSecret,
          deliveries: webhookDeliveries,
          installationStore,
          repositoryStore,
          repositoryClient,
        } : undefined,
      };
    }
  } else if (githubAppSlug()) {
    throw new Error("GITHUB_APP_SLUG requires GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET");
  }

  const app = createChatApp(store, provider, demo, port, auth, origin.origin, githubApp, runs);
  const allowedHosts = new Set([origin.host]);
  if (origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)) {
    const localPort = origin.port || String(port);
    allowedHosts.add(`localhost:${localPort}`);
    allowedHosts.add(`127.0.0.1:${localPort}`);
  }

  const server = createServer(async (req, res) => {
    try {
      if (!req.headers.host || !allowedHosts.has(req.headers.host)) {
        res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid host." }));
        return;
      }
      const chunks: Buffer[] = []; let size = 0;
      const maxBodySize = req.url?.startsWith("/webhooks/github") ? 1024 * 1024 : 20000;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodySize) { res.writeHead(413).end("Request too large"); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const response = await app(new Request(new URL(req.url || "/", origin.origin), {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error("[http] request failed", { method: req.method, path: req.url, error: error instanceof Error ? error.message : String(error) });
      res.writeHead(500).end("Request failed");
    }
  });
  server.requestTimeout = 120000;
  server.listen(port, "127.0.0.1", () => console.log(`journey-harness: ${origin.origin}${demo ? " (demo: no AI, temporary history)" : " (OpenCode + MongoDB)"}${auth ? " · GitHub auth enabled" : " · local anonymous mode"}${githubApp ? " · GitHub App install enabled" : ""}${githubApp?.repositoryClient ? " · repo sync enabled" : ""}${githubApp?.credentialBroker ? " · agent credentials enabled" : ""}${githubApp?.repositoryExecutor ? " · agent execution enabled" : ""}${githubApp?.webhook ? " · webhook enabled" : ""}`));
  server.on("error", async () => { console.error("Cannot start server. Check that PORT is available."); await db?.client.close(); process.exitCode = 1; });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    server.close(() => { void db?.client.close(); });
  });
}
main().catch((error) => {
  console.error("[startup] failed", error instanceof Error ? error.message : String(error));
  console.error("Startup failed. Check MONGODB_URI, MongoDB connectivity, GitHub settings, and .env. Docker is optional; to try the UI without services use: npm run chat:demo");
  process.exitCode = 1;
});
