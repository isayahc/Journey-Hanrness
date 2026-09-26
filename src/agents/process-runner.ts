import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface CommandRunner {
  run(command: string, args: string[], options: CommandOptions): Promise<CommandResult>;
}

function boundedAppend(current: string, chunk: Buffer | string, max = 32_000) {
  const next = current + chunk.toString();
  return next.length <= max ? next : next.slice(next.length - max);
}

export async function workspaceEnvironment(workspace: string, extra: Record<string, string> = {}) {
  const temp = join(workspace, ".journey-tmp");
  await mkdir(temp, { recursive: true });
  const source = process.env;
  const env: Record<string, string> = {
    PATH: source.PATH || "",
    CI: "1",
    HOME: workspace,
    USERPROFILE: workspace,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    npm_config_cache: join(workspace, ".npm-cache"),
    ...extra,
  };
  for (const key of ["SystemRoot", "ComSpec", "PATHEXT", "WINDIR", "LANG", "LC_ALL"]) {
    if (source[key]) env[key] = source[key]!;
  }
  return env;
}

export class NodeCommandRunner implements CommandRunner {
  async run(command: string, args: string[], options: CommandOptions) {
    const timeoutMs = options.timeoutMs ?? 120_000;
    return new Promise<CommandResult>((resolve, reject) => {
      const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout = boundedAppend(stdout, chunk); });
      child.stderr.on("data", chunk => { stderr = boundedAppend(stderr, chunk); });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.once("error", error => {
        clearTimeout(timer);
        reject(new Error(`COMMAND_START_FAILED:${error.name}`));
      });
      child.once("close", code => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}
