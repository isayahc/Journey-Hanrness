import { createSign } from "node:crypto";
import { z } from "zod";

const tokenResponse = z.object({
  token: z.string().min(1),
  expires_at: z.string().min(1),
});
const repository = z.object({
  id: z.number().int().positive(),
  full_name: z.string().min(1),
  default_branch: z.string().min(1),
  private: z.boolean(),
  archived: z.boolean().optional().default(false),
});
const repositoriesResponse = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(repository),
});
const gitRefResponse = z.object({
  object: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/i) }),
});
const pullRequestResponse = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
});

export interface GitHubInstallationRepository {
  repositoryId: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
}

export interface GitHubInstallationPermissions {
  contents?: "read" | "write";
  pull_requests?: "read" | "write";
  issues?: "read" | "write";
  checks?: "read" | "write";
  actions?: "read" | "write";
  statuses?: "read" | "write";
}

export interface GitHubRepositoryCredential {
  token: string;
  expiresAt: Date;
}

export interface GitHubPullRequestResult {
  number: number;
  url: string;
}

export interface GitHubAppRepositoryClient {
  listInstallationRepositories(installationId: number): Promise<GitHubInstallationRepository[]>;
}

export interface GitHubRepositoryHeadClient {
  getRepositoryBranchHead(
    installationId: number,
    repositoryId: number,
    fullName: string,
    branch: string,
  ): Promise<string>;
}

export interface GitHubPullRequestClient {
  createRepositoryPullRequest(
    installationId: number,
    repositoryId: number,
    fullName: string,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<GitHubPullRequestResult>;
}

export interface GitHubInstallationCredentialMinter {
  mintRepositoryCredential(
    installationId: number,
    repositoryId: number,
    permissions: GitHubInstallationPermissions,
  ): Promise<GitHubRepositoryCredential>;
}

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function validateRepositoryName(fullName: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new Error("INVALID_GITHUB_REPOSITORY_NAME");
}

function validateBranch(branch: string) {
  if (!branch || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/")) {
    throw new Error("INVALID_GITHUB_BRANCH");
  }
}

export class GitHubAppClient implements GitHubAppRepositoryClient, GitHubRepositoryHeadClient, GitHubPullRequestClient, GitHubInstallationCredentialMinter {
  constructor(
    private appId: string,
    private privateKey: string,
    private request: typeof fetch = fetch,
    private now: () => number = () => Date.now(),
  ) {}

  private jwt() {
    const nowSeconds = Math.floor(this.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: this.appId,
    }));
    const signingInput = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(this.privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  private async installationToken(
    installationId: number,
    scope?: {
      repositoryIds?: number[];
      permissions?: GitHubInstallationPermissions;
    },
  ) {
    const response = await this.request(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.jwt()}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: scope ? JSON.stringify({
          ...(scope.repositoryIds ? { repository_ids: scope.repositoryIds } : {}),
          ...(scope.permissions ? { permissions: scope.permissions } : {}),
        }) : undefined,
      },
    );
    if (response.status === 404) throw new Error("GITHUB_INSTALLATION_UNAVAILABLE");
    if (!response.ok) throw new Error("GitHub installation token request failed");
    const parsed = tokenResponse.parse(await response.json());
    return {
      token: parsed.token,
      expiresAt: new Date(parsed.expires_at),
    };
  }

  async mintRepositoryCredential(
    installationId: number,
    repositoryId: number,
    permissions: GitHubInstallationPermissions,
  ) {
    return this.installationToken(installationId, {
      repositoryIds: [repositoryId],
      permissions,
    });
  }

  async getRepositoryBranchHead(
    installationId: number,
    repositoryId: number,
    fullName: string,
    branch: string,
  ) {
    validateRepositoryName(fullName);
    validateBranch(branch);
    const credential = await this.mintRepositoryCredential(installationId, repositoryId, { contents: "read" });
    const ref = branch.split("/").map(encodeURIComponent).join("/");
    const response = await this.request(
      `https://api.github.com/repos/${fullName}/git/ref/heads/${ref}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${credential.token}`,
          "X-GitHub-Api-Version": "2026-03-10",
        },
      },
    );
    if (!response.ok) throw new Error("GITHUB_BRANCH_HEAD_LOOKUP_FAILED");
    return gitRefResponse.parse(await response.json()).object.sha;
  }

  async createRepositoryPullRequest(
    installationId: number,
    repositoryId: number,
    fullName: string,
    input: { title: string; body: string; head: string; base: string },
  ) {
    validateRepositoryName(fullName);
    validateBranch(input.head);
    validateBranch(input.base);
    const credential = await this.mintRepositoryCredential(installationId, repositoryId, {
      contents: "read",
      pull_requests: "write",
    });
    const response = await this.request(`https://api.github.com/repos/${fullName}/pulls`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error("GITHUB_PULL_REQUEST_CREATE_FAILED");
    const pullRequest = pullRequestResponse.parse(await response.json());
    return { number: pullRequest.number, url: pullRequest.html_url };
  }

  async listInstallationRepositories(installationId: number) {
    const credential = await this.installationToken(installationId);
    const repositories: GitHubInstallationRepository[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(
        `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${credential.token}`,
            "X-GitHub-Api-Version": "2026-03-10",
          },
        },
      );
      if (!response.ok) throw new Error("GitHub installation repository lookup failed");
      const payload = repositoriesResponse.parse(await response.json());
      repositories.push(...payload.repositories.map(item => ({
        repositoryId: item.id,
        fullName: item.full_name,
        defaultBranch: item.default_branch,
        private: item.private,
        archived: item.archived,
      })));
      if (payload.repositories.length < 100) break;
    }
    return repositories;
  }
}

export function githubAppClientFromEnv(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch) {
  const appId = env.GITHUB_APP_ID?.trim();
  const rawPrivateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId && !rawPrivateKey) return null;
  if (!appId || !rawPrivateKey) throw new Error("Set both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY to enable repository synchronization");
  if (!/^\d+$/.test(appId)) throw new Error("GITHUB_APP_ID must be numeric");
  const privateKey = rawPrivateKey.includes("\\n") ? rawPrivateKey.replaceAll("\\n", "\n") : rawPrivateKey;
  return new GitHubAppClient(appId, privateKey, request);
}
