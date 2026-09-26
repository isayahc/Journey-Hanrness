import { spawn } from "node:child_process";
import { opencodeBinary, root, runtimeEnvironment, stop } from "./runtime.mjs";

try {
  const child = spawn(opencodeBinary(), process.argv.slice(2), { cwd: root, env: runtimeEnvironment(), stdio: "inherit", shell: false });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stop(child); });
  child.once("error", () => { console.error("Cannot start the local OpenCode binary. Run npm install."); process.exitCode = 1; });
  child.once("close", (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1); });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
