import { GoalExecutor } from "../runs/executor.js";
import { publicJob } from "../agents/job-authorizations.js";
import { randomUUID } from "node:crypto";
import type { AgentGitHubCredentialBroker } from "../agents/credential-broker.js";
import type { AgentJobAuthorizationStore } from "../agents/job-authorizations.js";
import type { AgentRepositoryExecutor } from "../agents/repository-executor.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { GitHubInstallationVerifier } from "../auth/github.js";
import type { AuthStore, GitHubIdentity } from "../auth/store.js";
import type { GitHubOAuthClient } from "../auth/github.js";
import type { GitHubAppRepositoryClient } from "../github/app-client.js";
import type { GitHubInstallationStore } from "../github/installations.js";
import type { ConnectedRepositoryStore } from "../github/repositories.js";
import { handleGitHubWebhook, type GitHubWebhookRuntime } from "../github/webhooks.js";
import { OpenCodeChatError, type ChatProvider, type ChatRepositoryContext } from "./provider.js";
import type { ChatStore, Message, Conversation } from "./store.js";
import { ChatJobService, jobSubmissionError } from "./jobs.js";
import { recordActivity, type ActivityUpdate, type ChatActivity } from "./activity.js";
import { RunRequestError, type RunService } from "../runs/service.js";
import type { SearchService } from "../search/service.js";

const messageInput = z.object({ content: z.string().trim().min(1).max(4000), requestId: z.string().uuid().optional() }).strict();
const agentAccessInput = z.object({ enabled: z.boolean() }).strict();
const agentJobInput = z.object({ repositoryId: z.number().int().positive(), instruction: z.string().trim().min(1).max(12000) }).strict();
const uuid = z.string().uuid();
const assets: Record<string, [string, string]> = {
  "/markdown.js": ["markdown.js", "text/javascript"],
  "/vendor/marked.js": ["../node_modules/marked/lib/marked.umd.js", "text/javascript"],
  "/vendor/purify.js": ["../node_modules/dompurify/dist/purify.min.js", "text/javascript"],
  "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"],
  "/goals": ["goals.html", "text/html"], "/goals.js": ["goals.js", "text/javascript"],
};
const SESSION_COOKIE = "journey_session";
const OAUTH_STATE_COOKIE = "journey_oauth_state";
const INSTALL_STATE_COOKIE = "journey_install_state";
const OWNER_COOKIE = "journey_owner";
const executionIntent = (content: string) => /\b(build|create|implement|change|modify|fix|add|remove|update|refactor|scaffold|open (a )?pull request|try again|retry|resume|current|latest|today|news|research|official|source|sources|search|lookup)\b/i.test(content);

export interface AuthRuntime {
  store: AuthStore;
  github: GitHubOAuthClient;
  secureCookies?: boolean;
}

export interface GitHubAppRuntime {
  slug: string;
  store: GitHubInstallationStore;
  verifier: GitHubInstallationVerifier;
  repositoryStore: ConnectedRepositoryStore;
  repositoryClient?: GitHubAppRepositoryClient;
  credentialBroker?: AgentGitHubCredentialBroker;
  jobStore?: AgentJobAuthorizationStore;
  repositoryExecutor?: AgentRepositoryExecutor;
  webhook?: GitHubWebhookRuntime;
  executionError?: string;
}

function cookies(request: Request) {
  return Object.fromEntries((request.headers.get("cookie") || "").split(";").map(item => item.trim()).filter(Boolean).map(item => {
    const separator = item.indexOf("=");
    return separator < 0 ? [item, ""] : [item.slice(0, separator), item.slice(separator + 1)];
  }));
}

function setCookie(name: string, value: string, options: { maxAge: number; path?: string; secure?: boolean }) {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=${options.path || "/"}; Max-Age=${options.maxAge}${options.secure ? "; Secure" : ""}`;
}

function clearCookie(name: string, path = "/", secure = false) {
  return `${name}=; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=0${secure ? "; Secure" : ""}`;
}

function installationPermissionsAreSufficient(permissions: Record<string, string>) {
  const metadata = permissions.metadata;
  return (metadata === "read" || metadata === "write")
    && permissions.contents === "write"
    && permissions.pull_requests === "write";
}

async function syncGitHubRepositories(githubApp: GitHubAppRuntime, userId: string) {
  if (!githubApp.repositoryClient) throw new Error("GitHub repository synchronization is not configured.");
  const installations = await githubApp.store.listForUser(userId);
  if (!installations.length) throw new Error("GITHUB_CONNECTION_REQUIRED");
  let available = 0;
  for (const installation of installations) {
    try {
      const repositories = await githubApp.repositoryClient.listInstallationRepositories(installation.installationId);
      await githubApp.repositoryStore.syncInstallation(userId, installation.installationId, repositories);
      available++;
    } catch (error) {
      if (error instanceof Error && error.message === "GITHUB_INSTALLATION_UNAVAILABLE") {
        await githubApp.repositoryStore.syncInstallation(userId, installation.installationId, []);
        continue;
      }
      throw error;
    }
  }
  if (!available) throw new Error("GITHUB_CONNECTION_REQUIRED");
  return githubApp.repositoryStore.listForUser(userId);
}

export function createChatApp(
  store: ChatStore,
  provider: ChatProvider,
  demo: boolean,
  port: number,
  auth?: AuthRuntime,
  appOrigin = `http://localhost:${port}`,
  githubApp?: GitHubAppRuntime,
  runs?: RunService,
  search?: SearchService,
) {
  const busy = new Map<string, AbortController>();
  const chatJobs = new ChatJobService(store, auth ? githubApp : undefined);
  const goalExecutor = runs ? new GoalExecutor(runs.store, auth ? githubApp : undefined) : undefined;
  const withJobs = async (chat: Conversation) => ({ ...chat, jobs: await chatJobs.states(chat) });
  const runReply = async (ownerId: string, chatId: string, requestId: string) => {
    if (busy.has(chatId)) return;
    const controller = new AbortController();
    busy.set(chatId, controller);
    let activity: ChatActivity[] = [];
    let writes = Promise.resolve();
    let acceptingActivity = true;
    const onActivity = (update: ActivityUpdate) => {
      if (!acceptingActivity || controller.signal.aborted) return;
      const next = recordActivity(activity, update);
      if (next === activity) return;
      activity = next;
      writes = writes.then(() => store.updateReplyActivity(ownerId, chatId, requestId, next))
        .catch(() => { console.warn("[chat] Activity update unavailable"); });
    };
    try {
      const chat = await store.startReply(ownerId, chatId, requestId);
      if (!chat?.pendingReply) return;
      activity = chat.pendingReply.activity || [];
      onActivity({ id: "context", label: "Preparing your request", status: "running" });
      let github: ChatRepositoryContext = { status: "not_configured", total: 0, truncated: false, repositories: [] };
      if (auth && githubApp) {
        const [installations, repositories] = await Promise.all([
          githubApp.store.listForUser(ownerId), githubApp.repositoryStore.listForUser(ownerId),
        ]);
        const activeInstallations = new Set(installations.map(installation => installation.installationId));
        const connected = repositories.filter(repository => activeInstallations.has(repository.installationId));
        github = {
          status: installations.length ? "connected" : "not_connected", total: connected.length, truncated: connected.length > 200,
          repositories: connected.slice(0, 200).map(repository => ({
            fullName: repository.fullName, defaultBranch: repository.defaultBranch, private: repository.private,
            archived: repository.archived, agentEnabled: repository.agentEnabled && !repository.archived,
            lastSyncedAt: repository.lastSyncedAt.toISOString(),
          })),
        };
      }
      onActivity({ id: "context", label: "Request ready", status: "completed" });
      const wantsExecution = executionIntent(chat.pendingReply.content);
      const reply = await provider.reply(chat.messages, chat.opencodeSessionId, chat.opencodeSessionVersion,
        { ownerId, kind: "chat", resourceId: chat.id }, { signal: controller.signal, github, onActivity, ...(wantsExecution ? { execution: chatJobs.availability(), jobs: await chatJobs.states(chat) } : {}) });
      controller.signal.throwIfAborted();
      const assistant: Message = { role: "assistant", content: reply.content, requestId };
      if (reply.execution) {
        onActivity({ id: "repository", label: "Preparing repository job", status: "running" });
        try {
          assistant.job = await chatJobs.prepare(ownerId, reply.execution);
          onActivity({ id: "repository", label: "Repository job prepared", status: "completed" });
          assistant.content = `Job requested for ${assistant.job.repositoryFullName}. Progress, checks and the pull request will appear below.`;
        } catch (error) { assistant.content = jobSubmissionError(error); }
      }
      acceptingActivity = false;
      await writes;
      controller.signal.throwIfAborted();
      assistant.activity = activity;
      if (await store.completeReply(ownerId, chat.id, requestId, assistant, reply.opencodeSessionId, reply.opencodeSessionVersion)) {
        const saved = await store.get(ownerId, chat.id);
        if (saved && assistant.job) void chatJobs.dispatch(saved, assistant).catch(() => {});
      }
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      console.error("[chat] async reply failed", { chatId, error: message });
      const userError = cancelled ? "Reply stopped." : error instanceof OpenCodeChatError || message.startsWith("OpenCode server is unreachable")
        ? message : "Reply failed. Check MongoDB, your OpenCode server, and model access, then try again.";
      acceptingActivity = false;
      await writes;
      await store.failReply(ownerId, chatId, requestId, userError, cancelled);
      if (busy.get(chatId) === controller) busy.delete(chatId);
    } finally {
      acceptingActivity = false;
      if (busy.get(chatId) === controller) busy.delete(chatId);
    }
  };
  const recoverReplies = async () => {
    for (const chat of await store.pendingReplies()) if (chat.pendingReply) void runReply(chat.ownerId, chat.id, chat.pendingReply.requestId);
  };
  const configuredOrigin = new URL(appOrigin).origin;
  const allowed = new Set([configuredOrigin]);
  const originUrl = new URL(configuredOrigin);
  if (originUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(originUrl.hostname)) {
    allowed.add(`http://localhost:${originUrl.port || port}`);
    allowed.add(`http://127.0.0.1:${originUrl.port || port}`);
  }
  const secureCookies = auth?.secureCookies ?? originUrl.protocol === "https:";
  const installationCallbackUrl = new URL("/github/setup/callback", configuredOrigin).toString();

  const handle = async (request: Request): Promise<Response> => {
    const headers = new Headers({
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
    const redirect = (location: string, status = 302) => {
      headers.set("Location", location);
      return new Response(null, { status, headers });
    };
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      if (!githubApp?.webhook) return json({ error: "GitHub webhooks are not configured." }, 503);
      return handleGitHubWebhook(githubApp.webhook, request);
    }
    if (!allowed.has(url.origin)) return json({ error: "Invalid application origin." }, 403);
    if (request.method !== "GET" && (!allowed.has(request.headers.get("origin") || "") || !request.headers.get("content-type")?.startsWith("application/json"))) {
      return json({ error: "Send same-origin JSON requests." }, 403);
    }
    const requestCookies = cookies(request);

    const sessionUser = async (): Promise<GitHubIdentity | null> => {
      if (!auth) return null;
      const token = requestCookies[SESSION_COOKIE];
      return token ? auth.store.resolveSession(token) : null;
    };

    const ownerForChat = async () => {
      if (auth) {
        const user = await sessionUser();
        return user?.userId || null;
      }
      const cookie = requestCookies[OWNER_COOKIE];
      const ownerId = uuid.safeParse(cookie).success ? cookie! : randomUUID();
      if (ownerId !== cookie) headers.append("Set-Cookie", setCookie(OWNER_COOKIE, ownerId, { maxAge: 31536000 }));
      return ownerId;
    };

    try {
      if (request.method === "GET" && assets[url.pathname]) {
        const [file, type] = assets[url.pathname]!;
        headers.set("Content-Type", `${type}; charset=utf-8`);
        return new Response(await readFile(resolve("public", file), "utf8"), { headers });
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        return json({
          demo,
          storage: demo ? "memory" : "mongodb",
          authEnabled: Boolean(auth),
          githubAppEnabled: Boolean(auth && githubApp),
          agentJobsEnabled: Boolean(auth && githubApp?.repositoryExecutor && githubApp.jobStore),
          githubRepoSyncEnabled: Boolean(auth && githubApp?.repositoryClient),
          githubWebhookEnabled: Boolean(githubApp?.webhook),
          agentCredentialBrokerEnabled: Boolean(githubApp?.credentialBroker),
          agentExecutionEnabled: Boolean(githubApp?.repositoryExecutor),
          goalPlanningEnabled: Boolean(runs),
          goalExecution: goalExecutor?.availability() || { enabled: false },
          webSearch: { provider: "tavily", configured: !!search?.enabled },
        });
      }

      if (request.method === "GET" && url.pathname === "/auth/github") {
        if (!auth) return json({ error: "GitHub sign-in is not configured." }, 503);
        const state = await auth.store.createOAuthState();
        headers.append("Set-Cookie", setCookie(OAUTH_STATE_COOKIE, state, { maxAge: 600, path: "/auth/github/callback", secure: secureCookies }));
        return redirect(auth.github.authorizationUrl(state));
      }

      if (request.method === "GET" && url.pathname === "/auth/github/callback") {
        if (!auth) return json({ error: "GitHub sign-in is not configured." }, 503);
        if (url.searchParams.get("error")) {
          headers.append("Set-Cookie", clearCookie(OAUTH_STATE_COOKIE, "/auth/github/callback", secureCookies));
          return redirect("/?auth=denied");
        }
        const state = url.searchParams.get("state") || "";
        const code = url.searchParams.get("code") || "";
        if (!state || !code || !await auth.store.consumeOAuthState(state, requestCookies[OAUTH_STATE_COOKIE])) {
          headers.append("Set-Cookie", clearCookie(OAUTH_STATE_COOKIE, "/auth/github/callback", secureCookies));
          return json({ error: "GitHub sign-in state is invalid or expired. Start sign-in again." }, 400);
        }
        try {
          const profile = await auth.github.exchangeCode(code);
          const identity = await auth.store.bindGitHubUser(profile);
          const session = await auth.store.createSession(identity.userId);
          headers.append("Set-Cookie", setCookie(SESSION_COOKIE, session.token, { maxAge: Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)), secure: secureCookies }));
          return redirect("/");
        } catch (error) {
          console.error("[auth] GitHub callback failed", { error: error instanceof Error ? error.message : String(error) });
          headers.append("Set-Cookie", clearCookie(OAUTH_STATE_COOKIE, "/auth/github/callback", secureCookies));
          return redirect("/?auth=failed");
        }
      }

      if (request.method === "GET" && url.pathname === "/api/me") {
        if (!auth) return json({ error: "Authentication is not configured." }, 404);
        const user = await sessionUser();
        if (!user) return json({ error: "Sign in with GitHub to continue." }, 401);
        return json({
          userId: user.userId,
          githubUserId: user.githubUserId,
          githubLogin: user.githubLogin,
          ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
        });
      }

      if (request.method === "POST" && url.pathname === "/auth/logout") {
        if (!auth) return json({ ok: true });
        const token = requestCookies[SESSION_COOKIE];
        if (token) await auth.store.deleteSession(token);
        headers.append("Set-Cookie", clearCookie(SESSION_COOKIE, "/", secureCookies));
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/github/install") {
        if (!auth || !githubApp) return json({ error: "GitHub App installation is not configured." }, 503);
        const user = await sessionUser();
        if (!user) return json({ error: "Sign in with GitHub before connecting repositories." }, 401);
        return redirect(`https://github.com/apps/${githubApp.slug}/installations/new`);
      }

      if (request.method === "GET" && ["/github/setup", "/github/connect"].includes(url.pathname)) {
        if (!auth || !githubApp) return redirect("/?github=unavailable");
        const user = await sessionUser();
        if (!user) return redirect("/?github=signin");
        const discovering = url.pathname === "/github/connect";
        if (!discovering && url.searchParams.get("setup_action") === "request") return redirect("/?github=requested");
        const installationId = discovering ? null : Number(url.searchParams.get("installation_id"));
        if (installationId !== null && (!Number.isSafeInteger(installationId) || installationId <= 0)) return redirect("/?github=failed");
        const state = await githubApp.store.createVerificationState(user.userId, installationId);
        headers.append("Set-Cookie", setCookie(INSTALL_STATE_COOKIE, state, {
          maxAge: 600,
          path: "/github/setup/callback",
          secure: secureCookies,
        }));
        return redirect(githubApp.verifier.installationAuthorizationUrl(state, installationCallbackUrl));
      }

      if (request.method === "GET" && url.pathname === "/github/setup/callback") {
        if (!auth || !githubApp) return redirect("/?github=unavailable");
        headers.append("Set-Cookie", clearCookie(INSTALL_STATE_COOKIE, "/github/setup/callback", secureCookies));
        if (url.searchParams.get("error")) return redirect("/?github=denied");
        const user = await sessionUser();
        if (!user) return redirect("/?github=signin");
        const state = url.searchParams.get("state") || "";
        const code = url.searchParams.get("code") || "";
        const verification = state && code
          ? await githubApp.store.consumeVerificationState(state, requestCookies[INSTALL_STATE_COOKIE], user.userId)
          : null;
        if (!verification) return json({ error: "GitHub installation verification state is invalid or expired." }, 400);
        const { installationId } = verification;
        try {
          const verified = await githubApp.verifier.verifyInstallationCode(code, installationCallbackUrl, installationId, githubApp.slug);
          if (verified.profile.id !== user.githubUserId) return redirect("/?github=account-mismatch");
          if (!verified.installations.length) return redirect(installationId === null ? "/github/install" : "/?github=unauthorized");
          const installations = verified.installations.filter(item => installationPermissionsAreSufficient(item.permissions));
          if (!installations.length) return redirect("/?github=permissions");
          for (const installation of installations) {
            if (githubApp.repositoryClient) {
              const repositories = await githubApp.repositoryClient.listInstallationRepositories(installation.installationId);
              await githubApp.repositoryStore.syncInstallation(user.userId, installation.installationId, repositories);
            }
            await githubApp.store.linkInstallation(user.userId, installation);
          }
          return redirect("/?github=connected");
        } catch (error) {
          console.error("[github-app] installation verification failed", {
            userId: user.userId,
            installationId,
            error: error instanceof Error ? error.message : String(error),
          });
          return redirect("/?github=failed");
        }
      }

      if (request.method === "GET" && url.pathname === "/api/github/installations") {
        if (!auth || !githubApp) return json({ error: "GitHub App installation is not configured." }, 503);
        const user = await sessionUser();
        if (!user) return json({ error: "Sign in with GitHub to continue." }, 401);
        return json(await githubApp.store.listForUser(user.userId));
      }

      if (request.method === "GET" && url.pathname === "/api/github/repositories") {
        if (!auth || !githubApp) return json({ error: "GitHub App installation is not configured." }, 503);
        const user = await sessionUser();
        if (!user) return json({ error: "Sign in with GitHub to continue." }, 401);
        return json(await githubApp.repositoryStore.listForUser(user.userId));
      }

      if (request.method === "POST" && url.pathname === "/api/github/repositories/sync") {
        if (!auth || !githubApp?.repositoryClient) return json({ error: "GitHub repository synchronization is not configured." }, 503);
        const user = await sessionUser();
        if (!user) return json({ error: "Sign in with GitHub to continue." }, 401);
        try {
          return json(await syncGitHubRepositories(githubApp, user.userId));
        } catch (error) {
          if (error instanceof Error && error.message === "GITHUB_CONNECTION_REQUIRED") {
            return json({
              error: "Reconnect GitHub to verify your existing installation and sync repositories.",
              code: "GITHUB_CONNECTION_REQUIRED",
            }, 409);
          }
          console.error("[github-app] repository sync failed", { userId: user.userId, error: error instanceof Error ? error.message : String(error) });
          return json({ error: "GitHub repository synchronization failed." }, 502);
        }
      }

      const repositoryAccessMatch = /^\/api\/github\/repositories\/(\d+)\/agent-access$/.exec(url.pathname);
      if (request.method === "POST" && repositoryAccessMatch) {
        if (!auth || !githubApp) return json({ error: "GitHub App installation is not configured." }, 503);
        const user = await sessionUser();
        if (!user) return json({ error: "Sign in with GitHub to continue." }, 401);
        const repositoryId = Number(repositoryAccessMatch[1]);
        if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) return json({ error: "Invalid repository." }, 400);
        let input;
        try { input = agentAccessInput.parse(await request.json()); } catch { return json({ error: "Invalid agent access setting." }, 400); }
        const repository = await githubApp.repositoryStore.setAgentEnabled(user.userId, repositoryId, input.enabled);
        if (!repository) return json({ error: "Repository not found or no longer available." }, 404);
        return json(repository);
      }

      if (request.method === "GET" && url.pathname === "/api/agent-jobs") {
        if (!auth || !githubApp?.jobStore) return json({ error: "Agent jobs are not configured." }, 503);
        const user = await sessionUser();
        if (!user) return json({ error: "Sign in with GitHub to continue." }, 401);
        return json((await githubApp.jobStore.listForUser(user.userId)).map(publicJob));
      }

      if (request.method === "POST" && url.pathname === "/api/agent-jobs") {
        if (!auth || !githubApp?.repositoryExecutor || !githubApp.jobStore) {
          return json({ error: "Agent repository execution is not configured." }, 503);
        }
        const user = await sessionUser();
        if (!user) return json({ error: "Sign in with GitHub to continue." }, 401);
        let input;
        try { input = agentJobInput.parse(await request.json()); } catch { return json({ error: "Invalid agent job request." }, 400); }
        try {
          const job = await githubApp.repositoryExecutor.createJob({
            userId: user.userId,
            repositoryId: input.repositoryId,
            instruction: input.instruction,
          });
          void githubApp.repositoryExecutor.execute(job, input.instruction).catch(error => {
            console.error("[agent-job] execution failed", {
              jobId: job.jobId,
              error: error instanceof Error ? error.message : "AGENT_EXECUTION_FAILED",
            });
          });
          return json(publicJob(job), 202);
        } catch (error) {
          const code = error instanceof Error ? error.message : "AGENT_EXECUTION_FAILED";
          if (code === "AGENT_REPOSITORY_NOT_AUTHORIZED" || code === "AGENT_POLICY_DENIED") {
            return json({ error: "Repository is not authorized for agent work." }, 403);
          }
          return json({ error: "Agent job could not be created." }, 502);
        }
      }

      const jobActionMatch = /^\/api\/agent-jobs\/([0-9a-f-]{36})\/(resume|cancel)$/.exec(url.pathname);
      if (request.method === "POST" && jobActionMatch) {
        if (!auth || !githubApp?.jobStore || !githubApp.repositoryExecutor) return json({ error: "Agent jobs are not configured." }, 503);
        const user = await sessionUser();
        if (!user) return json({ error: "Sign in with GitHub to continue." }, 401);
        const job = await githubApp.jobStore.get(jobActionMatch[1]!, user.userId);
        if (!job) {
          const cancelled = jobActionMatch[2] === "cancel" ? await chatJobs.cancelPending(user.userId, jobActionMatch[1]!) : null;
          return cancelled ? json(cancelled) : json({ error: "Agent job not found." }, 404);
        }
        if (jobActionMatch[2] === "cancel") {
          const cancelled = await githubApp.repositoryExecutor.cancel(job.jobId, user.userId);
          return json(cancelled ? publicJob(cancelled) : null);
        }
        if (job.run) return json({ error: "Resume this job through its goal run so saved attempt and time limits remain enforced." }, 409);
        if (["completed", "cancelled"].includes(job.status) || (job.leaseUntil && job.leaseUntil > new Date())) {
          return json({ error: "Job is finished or still leased by a worker." }, 409);
        }
        if (job.chat) {
          const linked = await store.getByJob(user.userId, job.jobId);
          if (!linked || linked.messages.find(message => message.job?.jobId === job.jobId)?.job?.cancelled) return json({ error: "Job was cancelled or its conversation is unavailable." }, 409);
          try {
            const authorized = await chatJobs.prepare(user.userId, { repository: job.repositoryFullName!, instruction: job.request!, scaffold: job.scaffold || null });
            if (authorized.repositoryId !== job.repositoryId) throw new Error("AGENT_REPOSITORY_NOT_AUTHORIZED");
          }
          catch (error) { return json({ error: jobSubmissionError(error) }, 403); }
        }
        void githubApp.repositoryExecutor.execute(job, job.request || "").catch(() => {
          // The executor persists only sanitized failure codes on the owner-scoped job.
        });
        return json({ jobId: job.jobId, status: "resuming" }, 202);
      }

      const agentJobMatch = /^\/api\/agent-jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (request.method === "GET" && agentJobMatch) {
        if (!auth || !githubApp?.jobStore) return json({ error: "Agent jobs are not configured." }, 503);
        const user = await sessionUser();
        if (!user) return json({ error: "Sign in with GitHub to continue." }, 401);
        if (!uuid.safeParse(agentJobMatch[1]).success) return json({ error: "Invalid agent job." }, 400);
        const job = await githubApp.jobStore.get(agentJobMatch[1]!, user.userId);
        return job ? json(publicJob(job)) : json({ error: "Agent job not found." }, 404);
      }

      if (url.pathname === "/api/runs" || url.pathname.startsWith("/api/runs/")) {
        if (!runs) return json({ error: "Goal planning is not configured." }, 503);
        const ownerId = await ownerForChat();
        if (!ownerId) return json({ error: "Sign in with GitHub to continue." }, 401);
        try {
          if (url.pathname === "/api/runs") {
            if (request.method === "GET") return json(await runs.list(ownerId));
            if (request.method === "POST") {
              let input;
              try { input = await request.json(); } catch { return json({ error: "Send a valid JSON goal and success criteria." }, 400); }
              return json(await runs.create(ownerId, input), 201);
            }
          }
          const match = /^\/api\/runs\/([^/]+)(\/(?:plan|evidence|execute|resume))?$/.exec(url.pathname);
          if (!match || !uuid.safeParse(match[1]).success) return json({ error: "Run not found." }, 404);
          if (request.method === "GET" && !match[2]) return json(await runs.get(ownerId, match[1]!));
          if (request.method === "GET" && match[2] === "/evidence") {
            await runs.get(ownerId, match[1]!);
            return json(await search?.evidence({ ownerId, kind: "run", resourceId: match[1]! }) || []);
          }
          if (request.method === "POST" && match[2] === "/execute") {
            let input; try { input = await request.json(); } catch { return json({ error: "Send a valid repository selection." }, 400); }
            const run = await goalExecutor!.start(ownerId, match[1]!, input);
            void goalExecutor!.tick(ownerId, match[1]!).catch(() => {});
            return json(run, 202);
          }
          if (request.method === "POST" && match[2] === "/resume") {
            const run = await goalExecutor!.resume(ownerId, match[1]!);
            void goalExecutor!.tick(ownerId, match[1]!).catch(() => {});
            return json(run, 202);
          }
          if (request.method === "POST" && match[2] === "/plan") return json(await runs.plan(ownerId, match[1]!));
          return json({ error: "Not found." }, 404);
        } catch (error) {
          if (error instanceof RunRequestError) return json({ error: error.message }, error.status);
          throw error;
        }
      }

      if (url.pathname.startsWith("/api/chats")) {
        const ownerId = await ownerForChat();
        if (!ownerId) return json({ error: "Sign in with GitHub to continue." }, 401);
        if (url.pathname === "/api/chats") {
          if (request.method === "GET") return json(await store.list(ownerId));
          if (request.method === "POST") return json(await store.create(ownerId), 201);
        }
        const match = /^\/api\/chats\/([^/]+)(\/(?:messages|evidence|cancel|jobs))?$/.exec(url.pathname);
        if (!match || !uuid.safeParse(match[1]).success) return json({ error: "Not found." }, 404);
        const chat = await store.get(ownerId, match[1]!);
        if (!chat) return json({ error: "Conversation not found." }, 404);
        if (request.method === "GET" && !match[2]) return json(await withJobs(chat));
        if (request.method === "GET" && match[2] === "/jobs") return json(await chatJobs.states(chat));
        if (request.method === "GET" && match[2] === "/evidence") return json(await search?.evidence({ ownerId, kind: "chat", resourceId: chat.id }) || []);
        if (request.method === "POST" && match[2] === "/cancel") {
          const active = busy.get(chat.id);
          active?.abort(new DOMException("Reply stopped", "AbortError"));
          if (chat.pendingReply && ["queued", "running"].includes(chat.pendingReply.status)) await store.failReply(ownerId, chat.id, chat.pendingReply.requestId, "Reply stopped.", true);
          return json({ cancelled: Boolean(active || chat.pendingReply) });
        }
        if (request.method !== "POST" || match[2] !== "/messages") return json({ error: "Not found." }, 404);
        let input;
        try { input = messageInput.parse(await request.json()); } catch { return json({ error: "Enter a message of 1–4,000 characters." }, 400); }
        const requestId = input.requestId || randomUUID();
        const previous = chat.messages.find(message => message.role === "user" && message.requestId === requestId);
        if (previous && previous.content !== input.content) return json({ error: "This request ID belongs to a different message." }, 409);
        if (chat.messages.length >= 100) return json({ error: "Start a new chat to continue (50 turns per chat)." }, 400);
        if (chat.pendingReply) {
          if (["queued", "running"].includes(chat.pendingReply.status)) return json({ error: "A reply is already in progress." }, 409);
          if (chat.pendingReply.status === "failed" || chat.pendingReply.status === "cancelled") {
            if (busy.has(chat.id)) return json({ error: "The previous reply is still stopping. Try again shortly." }, 409);
            if (previous && !await store.retryReply(ownerId, chat.id, requestId, input.content)) return json({ error: "Chat changed in another tab. Reload before sending again." }, 409);
            if (previous) {
              void runReply(ownerId, chat.id, requestId);
              return json(await withJobs((await store.get(ownerId, chat.id))!), 202);
            }
          }
        }
        if (previous) return json(await withJobs(chat));
        if ((chat.pendingReply && ["queued", "running"].includes(chat.pendingReply.status)) || busy.has(chat.id)) return json({ error: "A reply is already in progress." }, 409);
        const user = { role: "user" as const, content: input.content, requestId };
        if (!await store.queueReply(chat, user)) return json({ error: "Chat changed in another tab. Reload before sending again." }, 409);
        void runReply(ownerId, chat.id, requestId);
        return json(await withJobs((await store.get(ownerId, chat.id))!), 202);
      }

      return json({ error: "Not found." }, 404);
    } catch (error) {
      console.error("[http] request failed", { path: url.pathname, error: error instanceof Error ? error.message : String(error) });
      return json({ error: "The service is temporarily unavailable. Please try again." }, 503);
    }
  };
  return Object.assign(handle, { recoverJobs: async () => { await Promise.all([recoverReplies(), chatJobs.recover(), goalExecutor?.recover()]); } });
}
