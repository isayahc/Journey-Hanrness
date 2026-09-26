import { MongoClient } from "mongodb";
import type { AgentJobAuthorization } from "./agents/job-authorizations.js";
import type { AuthSession, GitHubIdentity, OAuthState } from "./auth/store.js";
import type { GitHubInstallationLink, GitHubInstallationState } from "./github/installations.js";
import type { ConnectedRepository } from "./github/repositories.js";
import type { GitHubWebhookDelivery } from "./github/webhooks.js";
import type { PlatformUser, ProspectProfile, ResearchJob } from "./models.js";

export async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGODB_URI in .env before running database commands");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || "journey_harness");
    return {
      client,
      database: db,
      users: db.collection<PlatformUser>("users"),
      profiles: db.collection<ProspectProfile>("prospect_profiles"),
      jobs: db.collection<ResearchJob>("research_jobs"),
      githubIdentities: db.collection<GitHubIdentity>("github_identities"),
      authSessions: db.collection<AuthSession>("auth_sessions"),
      oauthStates: db.collection<OAuthState>("oauth_states"),
      githubInstallations: db.collection<GitHubInstallationLink>("github_installations"),
      githubInstallationStates: db.collection<GitHubInstallationState>("github_installation_states"),
      connectedRepositories: db.collection<ConnectedRepository>("connected_repositories"),
      githubWebhookDeliveries: db.collection<GitHubWebhookDelivery>("github_webhook_deliveries"),
      agentJobs: db.collection<AgentJobAuthorization>("agent_jobs"),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}
export type Database = Awaited<ReturnType<typeof connectDatabase>>;

export async function ensureIndexes(db: Database) {
  await Promise.all([
    db.users.createIndex({ userId: 1 }, { unique: true }),
    db.profiles.createIndex({ userId: 1 }, { unique: true }),
    db.jobs.createIndex({ jobId: 1 }, { unique: true }),
    db.jobs.createIndex({ status: 1, createdAt: 1 }),
    db.jobs.createIndex({ userId: 1 }, {
      unique: true, partialFilterExpression: { status: { $in: ["queued", "running"] } },
    }),
  ]);
}
