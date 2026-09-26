import type { AgentJobAuthorizationStore } from "./job-authorizations.js";
import type { GitHubInstallationCredentialMinter } from "../github/app-client.js";
import type { ConnectedRepositoryStore } from "../github/repositories.js";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const TOKEN_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
} as const;

export interface RepositoryCredentialRequest {
  userId: string;
  jobId: string;
  repositoryId: number;
}

export interface RepositoryCredential {
  token: string;
  expiresAt: Date;
}

interface CachedCredential extends RepositoryCredential {
  userId: string;
  jobId: string;
  repositoryId: number;
}

export class AgentGitHubCredentialBroker {
  private cache = new Map<string, CachedCredential>();

  constructor(
    private jobs: AgentJobAuthorizationStore,
    private repositories: ConnectedRepositoryStore,
    private minter: GitHubInstallationCredentialMinter,
    private now: () => number = () => Date.now(),
  ) {}

  private cacheKey(request: RepositoryCredentialRequest) {
    return `${request.userId}:${request.jobId}:${request.repositoryId}`;
  }

  async getRepositoryCredential(request: RepositoryCredentialRequest): Promise<RepositoryCredential> {
    const job = await this.jobs.authorizeCredentialJob(
      request.userId,
      request.jobId,
      request.repositoryId,
    );
    if (!job) throw new Error("AGENT_JOB_NOT_AUTHORIZED");

    const repository = await this.repositories.authorizeAgentRepository(
      request.userId,
      request.repositoryId,
    );
    if (!repository) throw new Error("AGENT_REPOSITORY_NOT_AUTHORIZED");

    const key = this.cacheKey(request);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt.getTime() > this.now() + REFRESH_MARGIN_MS) {
      return { token: cached.token, expiresAt: new Date(cached.expiresAt) };
    }

    let minted;
    try {
      minted = await this.minter.mintRepositoryCredential(
        repository.installationId,
        repository.repositoryId,
        TOKEN_PERMISSIONS,
      );
    } catch {
      throw new Error("GITHUB_CREDENTIAL_MINT_FAILED");
    }
    const expiresAtMs = minted.expiresAt.getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      throw new Error("GITHUB_INSTALLATION_CREDENTIAL_EXPIRED");
    }

    const credential: CachedCredential = {
      ...minted,
      userId: request.userId,
      jobId: request.jobId,
      repositoryId: request.repositoryId,
    };
    this.cache.set(key, credential);
    return { token: credential.token, expiresAt: new Date(credential.expiresAt) };
  }

  invalidateJob(userId: string, jobId: string) {
    const prefix = `${userId}:${jobId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }
}
