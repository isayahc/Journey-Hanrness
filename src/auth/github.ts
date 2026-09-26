import { z } from "zod";
import type { GitHubProfile } from "./store.js";

const tokenResponse = z.object({ access_token: z.string().min(1) });
const githubUser = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  name: z.string().nullable().optional(),
  avatar_url: z.string().url().nullable().optional(),
});
const installationAccount = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  type: z.enum(["User", "Organization"]),
});
const installation = z.object({
  id: z.number().int().positive(),
  account: installationAccount,
  repository_selection: z.enum(["all", "selected"]),
  permissions: z.record(z.string()),
  suspended_at: z.string().nullable().optional(),
});
const installationsResponse = z.object({
  total_count: z.number().int().nonnegative(),
  installations: z.array(installation),
});

export interface VerifiedGitHubInstallation {
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
}

export interface GitHubOAuthClient {
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<GitHubProfile>;
}

export interface GitHubInstallationVerifier {
  installationAuthorizationUrl(state: string, callbackUrl: string): string;
  verifyInstallationCode(code: string, callbackUrl: string, installationId: number): Promise<{
    profile: GitHubProfile;
    installation: VerifiedGitHubInstallation | null;
  }>;
}

export class GitHubOAuth implements GitHubOAuthClient, GitHubInstallationVerifier {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private callbackUrl: string,
    private request: typeof fetch = fetch,
  ) {}

  private buildAuthorizationUrl(state: string, callbackUrl: string) {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("state", state);
    return url.toString();
  }

  authorizationUrl(state: string) {
    return this.buildAuthorizationUrl(state, this.callbackUrl);
  }

  installationAuthorizationUrl(state: string, callbackUrl: string) {
    return this.buildAuthorizationUrl(state, callbackUrl);
  }

  private async exchangeAccessToken(code: string, callbackUrl: string) {
    const tokenResult = await this.request("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
    });
    if (!tokenResult.ok) throw new Error("GitHub token exchange failed");
    const token = tokenResponse.safeParse(await tokenResult.json());
    if (!token.success) throw new Error("GitHub did not return an access token");
    return token.data.access_token;
  }

  private async fetchProfile(accessToken: string): Promise<GitHubProfile> {
    const userResult = await this.request("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!userResult.ok) throw new Error("GitHub identity lookup failed");
    const user = githubUser.parse(await userResult.json());
    return { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatar_url };
  }

  async exchangeCode(code: string) {
    const accessToken = await this.exchangeAccessToken(code, this.callbackUrl);
    return this.fetchProfile(accessToken);
  }

  async verifyInstallationCode(code: string, callbackUrl: string, installationId: number) {
    const accessToken = await this.exchangeAccessToken(code, callbackUrl);
    const profile = await this.fetchProfile(accessToken);
    let page = 1;
    let match: z.infer<typeof installation> | undefined;
    while (page <= 100 && !match) {
      const response = await this.request(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!response.ok) throw new Error("GitHub installation lookup failed");
      const payload = installationsResponse.parse(await response.json());
      match = payload.installations.find(item => item.id === installationId);
      if (match || payload.installations.length < 100) break;
      page++;
    }
    return {
      profile,
      installation: match ? {
        installationId: match.id,
        accountId: match.account.id,
        accountLogin: match.account.login,
        accountType: match.account.type,
        repositorySelection: match.repository_selection,
        permissions: match.permissions,
      } : null,
    };
  }
}

export function githubOAuthFromEnv(appOrigin: string, env: NodeJS.ProcessEnv = process.env) {
  const clientId = env.GITHUB_APP_CLIENT_ID || env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET || env.GITHUB_CLIENT_SECRET;
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new Error("Set both GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET");
  return new GitHubOAuth(clientId, clientSecret, new URL("/auth/github/callback", appOrigin).toString());
}
