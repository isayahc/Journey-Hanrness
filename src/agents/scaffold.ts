import { scaffoldInput, type ScaffoldInput } from "../chat/execution.js";
import type { ExecutionWorkspace } from "./execution-environment.js";

// Fixed, noninteractive setup program executed only by the Daytona command runner.
// The model supplies neither shell text, a package, a version, nor CLI flags.
export const NEXT_SCAFFOLD_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [workspace, directory, jobId] = process.argv.slice(1);
const fail = code => process.exit(code);
if (!/^[0-9a-f-]{36}$/.test(jobId) || !/^(\.|[a-zA-Z0-9][a-zA-Z0-9_-]*(\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*)$/.test(directory)) fail(21);
const root = fs.realpathSync(workspace);
if (root !== path.resolve(workspace)) fail(21);
let target = root;
for (const part of directory === '.' ? [] : directory.split('/')) {
  target = path.join(target, part);
  if (fs.existsSync(target)) {
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink() || !info.isDirectory()) fail(21);
  } else fs.mkdirSync(target);
}
const state = path.join(path.dirname(root), 'scaffolds', jobId);
const stage = path.join(state, 'journey-app');
const marker = path.join(state, 'state.json');
const save = value => { fs.writeFileSync(marker + '.tmp', JSON.stringify(value)); fs.renameSync(marker + '.tmp', marker); };
const metadata = name => /^(readme(\.md|\.txt)?|license(\.md|\.txt)?|\.gitignore|\.git)$/i.test(name);
let saved = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
if (saved && saved.target !== target) fail(21);
if (saved?.phase === 'complete') process.exit(0);
if (!saved) {
  for (const name of fs.readdirSync(target)) {
    const stat = fs.lstatSync(path.join(target, name));
    if (!metadata(name) || stat.isSymbolicLink() || (stat.isDirectory() && name !== '.git')) fail(20);
  }
  fs.mkdirSync(state, { recursive: true });
  fs.rmSync(stage, { recursive: true, force: true });
  const result = spawnSync('npx', ['--yes', 'create-next-app@16.3.6', stage,
    '--ts', '--eslint', '--tailwind', '--app', '--src-dir', '--import-alias', '@/*',
    '--use-npm', '--skip-install', '--disable-git', '--yes'],
    { cwd: state, env: { ...process.env, CI: '1', NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'inherit', timeout: 600000 });
  if (result.status !== 0) fail(22);
  saved = { target, phase: 'applying', preserve: fs.readdirSync(target) };
  // Write the merge intent before copying; a restart repeats only these generated files.
  save(saved);
}
for (const name of fs.readdirSync(stage)) {
  if (name === '.git' || name === 'node_modules') fail(21);
  const from = path.join(stage, name), to = path.join(target, name);
  if (saved.preserve.includes(name)) {
    if (name === '.gitignore') {
      const existing = fs.readFileSync(to, 'utf8');
      const addition = fs.readFileSync(from, 'utf8');
      if (!existing.includes(addition)) fs.writeFileSync(to, existing + '\n' + addition);
    }
    continue; // Preserve the repository's README/license verbatim.
  }
  if (fs.existsSync(to) && fs.lstatSync(to).isSymbolicLink()) fail(21);
  fs.cpSync(from, to, { recursive: true, dereference: false });
}
save({ ...saved, phase: 'complete' });
`;

export async function scaffoldNextApp(session: ExecutionWorkspace, jobId: string, input: ScaffoldInput) {
  const scaffold = scaffoldInput.parse(input);
  const result = await session.commands.run("node", ["-e", NEXT_SCAFFOLD_SCRIPT, session.path, scaffold.directory, jobId], {
    cwd: session.path, env: await session.environment(session.path, { CI: "1", NEXT_TELEMETRY_DISABLED: "1" }), timeoutMs: 12 * 60 * 1000,
  });
  if (result.code !== 0) throw new Error(result.code === 20 ? "AGENT_SCAFFOLD_CONFLICT" : result.code === 21 ? "AGENT_SCAFFOLD_PATH_DENIED" : "AGENT_SCAFFOLD_FAILED");
}
