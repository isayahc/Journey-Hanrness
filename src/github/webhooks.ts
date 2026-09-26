import { createHmac, timingSafeEqual } from "node:crypto";
import type { Collection } from "mongodb";
import { z } from "zod";
import type { GitHubAppRepositoryClient } from "./app-client.js";
import type { GitHubInstallationStore } from "./installations.js";
import type { ConnectedRepositoryStore } from "./repositories.js";

const DELIVERY_TTL_SECONDS = 7 * 24 * 60 * 60;

const installationPayload = z.object({
  action: z.string().min(1),
  installation: z.object({ id: z.number().int().positive() }),
});

const installationRepositoriesPayload = z.object({
  action: z.enum(["added", "removed"]),
  installation: z.object({ id: z.number().int().positive() }),
  repositories_added: z.array(z.object({ id: z.number().int().positive() })).default([]),
  repositories_removed: z.array(z.object({ id: z.number().int().positive() })).default([]),
  repository_selection: z.enum(["all", "selected"]).optional(),
});

export interface GitHubWebhookDelivery {
  deliveryId: string;
  event: string;
  receivedAt: Date;
  processedAt?: Date;
}

export interface GitHubWebhookDeliveryStore {
  init(): Promise<void>;
  claim(deliveryId: string, event: string): Promise<boolean>;
  complete(deliveryId: string): Promise<void>;
  release(deliveryId: string): Promise<void>;
}

export class MongoGitHubWebhookDeliveryStore implements GitHubWebhookDeliveryStore {
  constructor(private deliveries: Collection<GitHubWebhookDelivery>) {}

  async init() {
    await Promise.all([
      this.deliveries.createIndex({ deliveryId: 1 }, { unique: true }),
      this.deliveries.createIndex({ receivedAt: 1 }, { expireAfterSeconds: DELIVERY_TTL_SECONDS }),
    ]);
  }

  async claim(deliveryId: string, event: string) {
    try {
      await this.deliveries.insertOne({ deliveryId, event, receivedAt: new Date() });
      return true;
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === 11000) return false;
      throw error;
    }
  }

  async complete(deliveryId: string) {
    await this.deliveries.updateOne({ deliveryId }, { $set: { processedAt: new Date() } });
  }

  async release(deliveryId: string) {
    await this.deliveries.deleteOne({ deliveryId });
  }
}

export class MemoryGitHubWebhookDeliveryStore implements GitHubWebhookDeliveryStore {
  private deliveries = new Map<string, GitHubWebhookDelivery>();
  async init() {}

  async claim(deliveryId: string, event: string) {
    if (this.deliveries.has(deliveryId)) return false;
    this.deliveries.set(deliveryId, { deliveryId, event, receivedAt: new Date() });
    return true;
  }

  async complete(deliveryId: string) {
    const record = this.deliveries.get(deliveryId);
    if (record) this.deliveries.set(deliveryId, { ...record, processedAt: new Date() });
  }

  async release(deliveryId: string) {
    this.deliveries.delete(deliveryId);
  }
}

export interface GitHubWebhookRuntime {
  secret: string;
  deliveries: GitHubWebhookDeliveryStore;
  installationStore: GitHubInstallationStore;
  repositoryStore: ConnectedRepositoryStore;
  repositoryClient?: GitHubAppRepositoryClient;
}

export function verifyGitHubWebhookSignature(secret: string, signature: string | null, body: Uint8Array) {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
    "utf8",
  );
  const actual = Buffer.from(signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function reconcileInstallation(runtime: GitHubWebhookRuntime, installationId: number) {
  const links = await runtime.installationStore.findByInstallationId(installationId);
  if (!links.length || !runtime.repositoryClient) return;
  try {
    const repositories = await runtime.repositoryClient.listInstallationRepositories(installationId);
    for (const link of links) {
      if (link.active === false || link.suspended === true) continue;
      await runtime.repositoryStore.syncInstallation(link.connectedByUserId, installationId, repositories);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "GITHUB_INSTALLATION_UNAVAILABLE") {
      await runtime.repositoryStore.disconnectInstallation(installationId);
      return;
    }
    throw error;
  }
}

export async function handleGitHubWebhook(
  runtime: GitHubWebhookRuntime,
  request: Request,
): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  if (!verifyGitHubWebhookSignature(runtime.secret, request.headers.get("x-hub-signature-256"), body)) {
    return Response.json({ error: "Invalid GitHub webhook signature." }, { status: 401 });
  }

  const deliveryId = request.headers.get("x-github-delivery")?.trim();
  const event = request.headers.get("x-github-event")?.trim();
  if (!deliveryId || !event) {
    return Response.json({ error: "Missing GitHub webhook delivery headers." }, { status: 400 });
  }

  const claimed = await runtime.deliveries.claim(deliveryId, event);
  if (!claimed) return Response.json({ ok: true, duplicate: true }, { status: 202 });

  try {
    const payload = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;

    if (event === "installation") {
      const parsed = installationPayload.parse(payload);
      const installationId = parsed.installation.id;
      if (parsed.action === "deleted") {
        await runtime.installationStore.setInstallationState(installationId, "deleted");
        await runtime.repositoryStore.disconnectInstallation(installationId);
      } else if (parsed.action === "suspend") {
        await runtime.installationStore.setInstallationState(installationId, "suspended");
        await runtime.repositoryStore.disconnectInstallation(installationId);
      } else if (parsed.action === "created" || parsed.action === "unsuspend") {
        await runtime.installationStore.setInstallationState(installationId, "active");
        await reconcileInstallation(runtime, installationId);
      }
    } else if (event === "installation_repositories") {
      const parsed = installationRepositoriesPayload.parse(payload);
      const installationId = parsed.installation.id;
      if (parsed.repositories_removed.length) {
        await runtime.repositoryStore.disconnectRepositories(
          installationId,
          parsed.repositories_removed.map(repository => repository.id),
        );
      }
      // A transition from "all" to "selected" can report an empty removed list,
      // so always reconcile the full installation when server credentials exist.
      await reconcileInstallation(runtime, installationId);
    }

    await runtime.deliveries.complete(deliveryId);
    return Response.json({ ok: true }, { status: 202 });
  } catch (error) {
    await runtime.deliveries.release(deliveryId);
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return Response.json({ error: "Invalid GitHub webhook payload." }, { status: 400 });
    }
    console.error("[github-webhook] processing failed", {
      deliveryId,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "GitHub webhook processing failed." }, { status: 500 });
  }
}

export function githubWebhookSecretFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return env.GITHUB_APP_WEBHOOK_SECRET?.trim() || null;
}
