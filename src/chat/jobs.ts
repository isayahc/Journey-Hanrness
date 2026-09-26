import { publicJob } from "../agents/job-authorizations.js";
import { randomUUID } from "node:crypto";
import type { GitHubAppRuntime } from "./app.js";
import { executionRequest, type ChatExecutionRequest, type ChatJobLink } from "./execution.js";
import type { ChatStore, Conversation, Message } from "./store.js";

export function jobSubmissionError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (["AGENT_POLICY_DENIED", "AGENT_REPOSITORY_NOT_AUTHORIZED"].includes(code)) return "Repository access is unavailable or its agent write policy denies this work. Reconnect GitHub, sync repositories, and enable agent access before trying again.";
  if (code === "GITHUB_BRANCH_HEAD_LOOKUP_FAILED" || code === "AGENT_BASE_COMMIT_REQUIRED") return "The repository has no accessible base commit. Initialize its default branch (for example with a README), sync GitHub access, and try again.";
  if (code === "DAYTONA_REQUIRED") return "Chat jobs require Daytona. Set JOURNEY_AGENT_EXECUTION_BACKEND=daytona and DAYTONA_API_KEY, enable execution, and restart the server.";
  return "The job could not be submitted. Check GitHub App credentials and Daytona configuration, then send the request again. No job success has been reported.";
}

/** A conversation append is the durable outbox. Only saved links can reach the executor. */
export class ChatJobService {
  constructor(private chats: ChatStore, private github?: GitHubAppRuntime) {}

  availability() {
    const enabled = !!this.github?.jobStore && this.github.repositoryExecutor?.backend === "daytona";
    return { enabled, ...(enabled ? {} : { reason: this.github?.executionError || "Chat jobs require GitHub sign-in, an enabled repository, JOURNEY_AGENT_EXECUTION_ENABLED=1, JOURNEY_AGENT_EXECUTION_BACKEND=daytona and DAYTONA_API_KEY. Configure these and restart the server." }) };
  }

  async prepare(ownerId: string, request: ChatExecutionRequest): Promise<ChatJobLink> {
    const input = executionRequest.parse(request);
    if (!this.availability().enabled) throw new Error("DAYTONA_REQUIRED");
    const [repositories, installations] = await Promise.all([
      this.github!.repositoryStore.listForUser(ownerId), this.github!.store.listForUser(ownerId),
    ]);
    const repository = repositories.find(repo => repo.fullName.toLowerCase() === input.repository.toLowerCase());
    if (!repository || !installations.some(item => item.installationId === repository.installationId)) throw new Error("AGENT_REPOSITORY_NOT_AUTHORIZED");
    for (const action of ["createBranch", "commit", "pushAgentBranch", "openPullRequest"] as const) {
      if (!await this.github!.repositoryStore.authorizeAgentRepositoryAction(ownerId, repository.repositoryId, action)) throw new Error("AGENT_POLICY_DENIED");
    }
    return {
      jobId: randomUUID(), repositoryId: repository.repositoryId, repositoryFullName: repository.fullName,
      instruction: input.instruction, ...(input.scaffold ? { scaffold: input.scaffold } : {}), pending: true,
    };
  }

  async states(chat: Conversation) {
    return Promise.all(chat.messages.filter(message => message.job).map(async message => {
      const link = message.job!;
      const job = await this.github?.jobStore?.get(link.jobId, chat.ownerId);
      return job ? publicJob(job) : {
        jobId: link.jobId, repositoryId: link.repositoryId, repositoryFullName: link.repositoryFullName,
        request: link.instruction, status: link.cancelled ? "cancelled" : link.error ? "submission_failed" : "queued", failure: link.error,
      };
    }));
  }

  async dispatch(chat: Conversation, message: Message) {
    const link = message.job;
    if (!link?.pending || link.cancelled) return;
    const latestLink = (await this.chats.get(chat.ownerId, chat.id))?.messages.find(item => item.job?.jobId === link.jobId)?.job;
    if (!latestLink?.pending || latestLink.cancelled) return;
    let job = await this.github?.jobStore?.get(link.jobId, chat.ownerId);
    if (!job) {
      try {
        // Recheck current access, including installation suspension, on restart delivery.
        const authorized = await this.prepare(chat.ownerId, { repository: link.repositoryFullName, instruction: link.instruction, scaffold: link.scaffold || null });
        if (authorized.repositoryId !== link.repositoryId) throw new Error("AGENT_REPOSITORY_NOT_AUTHORIZED");
        job = await this.github!.repositoryExecutor!.createJob({
          jobId: link.jobId, userId: chat.ownerId, repositoryId: link.repositoryId, instruction: link.instruction,
          scaffold: link.scaffold, chat: { id: chat.id, requestId: message.requestId! }, executionBackend: "daytona",
        });
      } catch (error) {
        // A concurrent dispatcher may have created this exact job before an API/DB response was lost.
        job = await this.github?.jobStore?.get(link.jobId, chat.ownerId);
        if (!job) { await this.chats.settleJob(chat.ownerId, chat.id, link.jobId, jobSubmissionError(error)); return; }
      }
    }
    const saved = await this.chats.get(chat.ownerId, chat.id);
    if (saved?.messages.find(item => item.job?.jobId === link.jobId)?.job?.cancelled) {
      await this.github?.repositoryExecutor?.cancel(job.jobId, chat.ownerId);
      return;
    }
    if (job.status === "queued") {
      // Leave the outbox pending until the claim is durable. A crash before claim retries the same ID.
      void this.github?.repositoryExecutor?.execute(job, job.request || "").catch(() => {});
    } else {
      await this.chats.settleJob(chat.ownerId, chat.id, link.jobId);
    }
  }

  async recover() {
    for (const chat of await this.chats.pendingJobs()) {
      for (const message of chat.messages) if (message.job?.pending) await this.dispatch(chat, message);
    }
  }

  async cancelPending(ownerId: string, jobId: string) {
    const chat = await this.chats.getByJob(ownerId, jobId);
    if (!chat) return null;
    await this.chats.settleJob(ownerId, chat.id, jobId, undefined, true);
    await this.github?.repositoryExecutor?.cancel(jobId, ownerId);
    return { jobId, status: "cancelled" };
  }
}
