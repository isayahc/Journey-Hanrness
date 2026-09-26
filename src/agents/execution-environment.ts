import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentJobAuthorization,
  AgentJobAuthorizationStore,
} from "./job-authorizations.js";
import type { CommandRunner } from "./process-runner.js";
import { workspaceEnvironment } from "./process-runner.js";
import type { RepositoryAgent } from "./opencode-repository-agent.js";

/** Job-scoped filesystem, commands, and agent in a single execution environment. */
export interface ExecutionWorkspace {
  path: string;
  root?: string;
  commands: CommandRunner;
  agent: RepositoryAgent;
  environment(
    cwd: string,
    extra?: Record<string, string>,
  ): Promise<Record<string, string>>;
  readText(path: string): Promise<string>;
  prepareChecks?(): Promise<void>;
  close(success: boolean, cancelled: boolean): Promise<void>;
}

/** Allocates or reconnects only the workspace belonging to this authorized job. */
export interface ExecutionEnvironment {
  open(
    job: AgentJobAuthorization,
    jobs: AgentJobAuthorizationStore,
  ): Promise<ExecutionWorkspace>;
  cancel?(
    job: AgentJobAuthorization,
    jobs: AgentJobAuthorizationStore,
  ): Promise<void>;
}

/** Explicit development executor using the host filesystem. */
export async function localWorkspace(
  path: string,
  commands: CommandRunner,
  agent: RepositoryAgent,
): Promise<ExecutionWorkspace> {
  await rm(path, { recursive: true, force: true });
  await mkdir(dirname(path), { recursive: true });
  return {
    path,
    commands,
    agent,
    environment: (cwd, extra) => workspaceEnvironment(cwd, extra),
    readText: (file) => readFile(file, "utf8"),
    close: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}
