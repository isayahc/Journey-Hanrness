import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Daytona, type Sandbox } from "@daytona/sdk";
import type {
  AgentJobAuthorization,
  AgentJobAuthorizationStore,
} from "./job-authorizations.js";
import type {
  ExecutionEnvironment,
  ExecutionWorkspace,
} from "./execution-environment.js";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "./process-runner.js";
import { OpenCodeRepositoryAgent } from "./opencode-repository-agent.js";

/** Quote one POSIX argument without allowing shell interpolation. */
export function shellArgument(value: string): string {
  if (value.includes("\0")) throw new Error("SANDBOX_COMMAND_FAILED");
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Executes argv through Daytona's shell API with bounded time/output and safe errors. */
export class DaytonaCommandRunner implements CommandRunner {
  constructor(
    private sandbox: Pick<Sandbox, "process">,
    private authorize: () => Promise<void>,
    private log: (
      command: string,
      code: number,
    ) => Promise<void> = async () => {},
  ) {}

  async run(
    command: string,
    args: string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    await this.authorize();
    try {
      const result = await this.sandbox.process.executeCommand(
        [command, ...args].map(shellArgument).join(" "),
        options.cwd,
        options.env,
        Math.min(
          900,
          Math.max(1, Math.ceil((options.timeoutMs ?? 120_000) / 1000)),
        ),
      );
      await this.log(command, result.exitCode ?? 1);
      // Credential-bearing commands never expose their output to persistence or the model.
      const output = options.env?.GIT_CONFIG_VALUE_0
        ? ""
        : (result.result || "").slice(-32_000);
      return { code: result.exitCode ?? 1, stdout: output, stderr: "" };
    } catch {
      throw new Error("SANDBOX_COMMAND_FAILED");
    }
  }
}

/** One private, time/resource bounded Daytona workspace per repository job. */
export class DaytonaExecutionEnvironment implements ExecutionEnvironment {
  readonly backend = "daytona" as const;
  private client: Pick<Daytona, "create" | "get" | "start" | "stop" | "delete">;

  constructor(
    private env: NodeJS.ProcessEnv = process.env,
    client?: Pick<Daytona, "create" | "get" | "start" | "stop" | "delete">,
    private http: typeof fetch = fetch,
  ) {
    if (!client && !env.DAYTONA_API_KEY)
      throw new Error("DAYTONA_API_KEY_REQUIRED");
    this.client =
      client ??
      new Daytona({
        apiKey: env.DAYTONA_API_KEY,
        apiUrl: env.DAYTONA_API_URL,
        target: env.DAYTONA_TARGET,
      });
  }

  /** Terminate active commands immediately; never trust a sandbox ID without owner labels. */
  async cancel(
    job: AgentJobAuthorization,
    jobs: AgentJobAuthorizationStore,
  ): Promise<void> {
    if (!job.sandbox || job.sandbox.state === "deleted") return;
    let state: NonNullable<AgentJobAuthorization["sandbox"]>["state"] =
      "cleanup_failed";
    try {
      const sandbox = await this.client.get(job.sandbox.id ?? job.sandbox.name);
      const owner = createHash("sha256").update(job.userId).digest("hex");
      if (
        sandbox.labels?.["journey-owner"] !== owner ||
        sandbox.labels?.["journey-job"] !== job.jobId
      )
        throw new Error("SANDBOX_OWNER_MISMATCH");
      await this.client.delete(sandbox, 60, true);
      state = "deleted";
    } finally {
      await jobs.updateExecution(job.jobId, job.userId, {
        sandbox: { ...job.sandbox, state, updatedAt: new Date() },
      });
    }
  }

  async open(
    job: AgentJobAuthorization,
    jobs: AgentJobAuthorizationStore,
  ): Promise<ExecutionWorkspace> {
    const authorize = async (): Promise<void> => {
      if (
        !(await jobs.authorizeCredentialJob(
          job.userId,
          job.jobId,
          job.repositoryId,
        ))
      )
        throw new Error("AGENT_JOB_NOT_AUTHORIZED");
    };
    await authorize();
    const owner = createHash("sha256").update(job.userId).digest("hex");
    const name = `journey-${job.jobId}`;
    const labels = { "journey-owner": owner, "journey-job": job.jobId };
    let record: NonNullable<AgentJobAuthorization["sandbox"]> = job.sandbox ?? {
      name,
      state: "provisioning",
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
    const persist = async (state: typeof record.state): Promise<void> => {
      record = { ...record, state, updatedAt: new Date() };
      if (
        !(await jobs.updateExecution(job.jobId, job.userId, {
          sandbox: record,
        }))
      )
        throw new Error("AGENT_JOB_NOT_AUTHORIZED");
    };
    let sandbox: Sandbox;
    try {
      if (job.sandbox) {
        // A failed lookup may be a connectivity error. Never provision a duplicate on that basis.
        sandbox = await this.client.get(job.sandbox.id ?? name);
        if (
          sandbox.labels?.["journey-owner"] !== owner ||
          sandbox.labels?.["journey-job"] !== job.jobId
        ) {
          throw new Error("SANDBOX_OWNER_MISMATCH");
        }
        if (record.expiresAt <= new Date() || record.state === "deleted")
          throw new Error("SANDBOX_EXPIRED");
        // Stop any surviving model/check process before a recovered worker uses the workspace.
        if (sandbox.state === "started") await this.client.stop(sandbox);
        await this.client.start(sandbox, 60);
      } else {
        await persist("provisioning");
        sandbox = await this.client.create(
          {
            name,
            labels,
            language: "typescript",
            public: false,
            image: this.env.DAYTONA_IMAGE || "node:22-bookworm",
            resources: { cpu: 2, memory: 4, disk: 10 },
            autoStopInterval: 30,
            autoDeleteInterval: 120,
            ttlMinutes: 1440,
          },
          { timeout: 120 },
        );
      }
      record = { ...record, id: sandbox.id };
      await persist("running");
    } catch (error) {
      if (
        error instanceof Error &&
        ["SANDBOX_OWNER_MISMATCH", "SANDBOX_EXPIRED"].includes(error.message)
      )
        throw error;
      throw new Error(
        job.sandbox ? "SANDBOX_RECONNECT_FAILED" : "SANDBOX_PROVISION_FAILED",
      );
    }
    const executionLog = [...(job.executionLog || [])];
    const commands = new DaytonaCommandRunner(
      sandbox,
      authorize,
      async (command, code) => {
        // Deliberately retain metadata only: stdout, args, environments, and preview tokens may contain secrets.
        executionLog.push({ command, code, at: new Date() });
        if (executionLog.length > 200) executionLog.shift();
        await jobs.updateExecution(job.jobId, job.userId, { executionLog });
      },
    );
    const path = "/tmp/journey/repository";
    const environment = async (
      _cwd: string,
      extra: Record<string, string> = {},
    ): Promise<Record<string, string>> => ({
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      CI: "1",
      HOME: "/tmp/journey/home",
      XDG_CONFIG_HOME: "/tmp/journey/home/.config",
      TMPDIR: "/tmp/journey/tmp",
      npm_config_cache: "/tmp/journey/cache",
      ...extra,
    });
    const close = async (
      success: boolean,
      cancelled: boolean,
    ): Promise<void> => {
      try {
        if (
          (await jobs.get(job.jobId, job.userId))?.sandbox?.state === "deleted"
        )
          return;
        if (success || cancelled) {
          await this.client.delete(sandbox, 60, true);
          await persist("deleted");
        } else {
          await this.client.stop(sandbox);
          await persist("stopped");
        }
      } catch {
        await persist("cleanup_failed");
      }
    };
    try {
      const setup = await commands.run(
        "mkdir",
        [
          "-p",
          posix.dirname(path),
          "/tmp/journey/home",
          "/tmp/journey/tmp",
          "/tmp/journey/runtime",
        ],
        { cwd: "/tmp" },
      );
      if (setup.code !== 0) throw new Error("SANDBOX_RUNTIME_FAILED");
      if (!job.checkpoint) {
        const reset = await commands.run("rm", ["-rf", "--", path], {
          cwd: "/tmp/journey",
        });
        if (reset.code !== 0) throw new Error("SANDBOX_RUNTIME_FAILED");
      }
      const install = await commands.run(
        "npm",
        [
          "install",
          "--prefix",
          "/tmp/journey/runtime",
          "--no-audit",
          "--no-fund",
          "opencode-ai@1.18.32",
        ],
        {
          cwd: "/tmp/journey/runtime",
          env: await environment(path),
          timeoutMs: 5 * 60 * 1000,
        },
      );
      if (install.code !== 0) throw new Error("SANDBOX_RUNTIME_FAILED");
      const password = randomUUID();
      // No host environment or GitHub credentials are inherited by the model process.
      const serverEnv = {
        ...(await environment(path)),
        OPENCODE_SERVER_PASSWORD: password,
      };
      // Pass the server password through the environment of a short-lived bootstrap,
      // never through arguments, files, or persisted command output.
      const start = await sandbox.process.executeCommand(
        "nohup /tmp/journey/runtime/node_modules/.bin/opencode serve --hostname 0.0.0.0 --port 4096 >/dev/null 2>&1 </dev/null &",
        "/tmp/journey",
        serverEnv,
        10,
      );
      if (start.exitCode !== 0) throw new Error("SANDBOX_RUNTIME_FAILED");
      const preview = await sandbox.getPreviewLink(4096);
      const fetcher: typeof fetch = async (input, init) => {
        const headers = new Headers(
          input instanceof Request ? input.headers : undefined,
        );
        new Headers(init?.headers).forEach((value, key) =>
          headers.set(key, value),
        );
        if (preview.token)
          headers.set("x-daytona-preview-token", preview.token);
        return this.http(input, { ...init, headers });
      };
      let healthy = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const response = await fetcher(`${preview.url}/global/health`, {
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
            },
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok) {
            healthy = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!healthy) throw new Error("SANDBOX_RUNTIME_FAILED");
      const agent = new OpenCodeRepositoryAgent(
        {
          OPENCODE_URL: preview.url,
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_MODEL: this.env.OPENCODE_MODEL,
        },
        fetcher,
      );
      return {
        path,
        root: "/tmp/journey",
        commands,
        agent,
        environment,
        close,
        prepareChecks: async (directory = path) => {
          if (directory !== path && !directory.startsWith(path + "/")) throw new Error("SANDBOX_PATH_DENIED");
          const lock = await commands.run(
            "test",
            ["-f", `${directory}/package-lock.json`],
            { cwd: directory },
          );
          if (![0, 1].includes(lock.code))
            throw new Error("AGENT_CHECK_FAILED");
          const dependencies = await commands.run(
            "npm",
            lock.code === 0
              ? ["ci", "--no-audit", "--no-fund"]
              : ["install", "--package-lock=false", "--no-audit", "--no-fund"],
            {
              cwd: directory,
              env: await environment(directory),
              timeoutMs: 10 * 60 * 1000,
            },
          );
          return { command: lock.code === 0 ? "npm ci" : "npm install --package-lock=false", ok: dependencies.code === 0 };
        },
        readText: async (file) => {
          if (!posix.normalize(file).startsWith(path + "/"))
            throw new Error("SANDBOX_PATH_DENIED");
          const exists = await commands.run("test", ["-f", file], {
            cwd: path,
            env: await environment(path),
          });
          if (exists.code === 1) {
            const error = new Error("FILE_NOT_FOUND");
            Object.assign(error, { code: "ENOENT" });
            throw error;
          }
          if (exists.code !== 0) throw new Error("SANDBOX_FILE_READ_FAILED");
          const result = await commands.run(
            "head",
            ["-c", "32001", "--", file],
            { cwd: path, env: await environment(path) },
          );
          if (result.code !== 0 || result.stdout.length >= 32_000)
            throw new Error("SANDBOX_FILE_READ_FAILED");
          return result.stdout;
        },
      };
    } catch {
      await close(
        false,
        (await jobs.get(job.jobId, job.userId))?.status === "cancelled",
      );
      throw new Error("SANDBOX_RUNTIME_FAILED");
    }
  }
}

/** Fail closed on misspelled backend names instead of silently running on the host. */
export function executionEnvironmentFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ExecutionEnvironment | undefined {
  const backend = env.JOURNEY_AGENT_EXECUTION_BACKEND || "local";
  if (backend === "local") return undefined;
  if (backend !== "daytona") throw new Error("INVALID_EXECUTION_BACKEND");
  return new DaytonaExecutionEnvironment(env);
}
