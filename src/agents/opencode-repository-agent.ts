import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { resolveOpenCodeModel } from "../opencode-model.js";

export interface RepositoryAgent {
  modify(workspace: string, instruction: string, options?: { model?: string; deadlineAt?: Date }): Promise<void>;
}

export class OpenCodeRepositoryAgent implements RepositoryAgent {
  private baseUrl: string;
  private model?: { providerID: string; modelID: string };
  private headers?: Record<string, string>;

  constructor(private env: NodeJS.ProcessEnv = process.env, private fetcher: typeof fetch = fetch) {
    const url = new URL(env.OPENCODE_URL || "http://127.0.0.1:4096");
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("OPENCODE_URL must use HTTP or HTTPS");
    this.baseUrl = url.toString();
    this.model = resolveOpenCodeModel(env).model;
    if (env.OPENCODE_SERVER_PASSWORD) {
      this.headers = {
        Authorization: `Basic ${Buffer.from(`${env.OPENCODE_SERVER_USERNAME || "opencode"}:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
      };
    }
  }

  async modify(workspace: string, instruction: string, options?: { model?: string; deadlineAt?: Date }) {
    const client = createOpencodeClient({
      baseUrl: this.baseUrl,
      directory: workspace,
      throwOnError: true,
      fetch: this.fetcher,
      headers: this.headers,
    });
    const remaining = options?.deadlineAt ? +options.deadlineAt - Date.now() : 15 * 60 * 1000;
    if (remaining <= 0) throw new Error("AGENT_DEADLINE_EXCEEDED");
    const signal = AbortSignal.timeout(Math.min(15 * 60 * 1000, remaining));
    const session = await client.session.create({
      title: "journey-harness repository job",
      permission: [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "edit", pattern: "*", action: "allow" },
        { permission: "glob", pattern: "*", action: "allow" },
        { permission: "grep", pattern: "*", action: "allow" },
        { permission: "list", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "git status*", action: "allow" },
        { permission: "bash", pattern: "git diff*", action: "allow" },
        { permission: "bash", pattern: "git log*", action: "allow" },
        { permission: "bash", pattern: "git grep*", action: "allow" },
        { permission: "edit", pattern: "**/.git/**", action: "deny" },
        { permission: "external_directory", pattern: "*", action: "deny" },
      ],
    }, { signal });
    if (!session.data) throw new Error("OPENCODE_SESSION_CREATE_FAILED");
    const result = await client.session.prompt({
      sessionID: session.data.id,
      model: options?.model ? resolveOpenCodeModel({ OPENCODE_MODEL: options.model }).model : this.model,
      system: [
        "You are the journey-harness repository modification agent.",
        "Work only inside the active repository workspace.",
        "Make the requested code changes directly.",
        "Do not commit, push, change remotes, or edit .git.",
        "Do not attempt to access paths outside the workspace.",
        "Use shell only for the explicitly allowed read-only git inspection commands.",
        "journey-harness will run checks, commit, and push after you finish.",
      ].join(" "),
      parts: [{ type: "text", text: instruction }],
    }, { signal });
    if (result.data?.info.error) throw new Error("OPENCODE_REPOSITORY_JOB_FAILED");
  }
}
