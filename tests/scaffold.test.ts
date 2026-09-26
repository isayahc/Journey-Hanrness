import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { NEXT_SCAFFOLD_SCRIPT, scaffoldNextApp } from '../src/agents/scaffold.js';
import { scaffoldInput } from '../src/chat/execution.js';
import type { ExecutionWorkspace } from '../src/agents/execution-environment.js';

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'journey-scaffold-')), repo = path.join(root, 'repo');
  fs.mkdirSync(repo); fs.mkdirSync(path.join(repo, '.git'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = randomUUID(), calls: any[] = [];
  let copyFailure = false;
  const run = (directory = '.') => {
    try {
      vm.runInNewContext(NEXT_SCAFFOLD_SCRIPT, {
        require(name: string) {
          if (name === 'node:fs') return { ...fs, cpSync(...args: Parameters<typeof fs.cpSync>) {
            if (copyFailure) { copyFailure = false; throw new Error('crash during copy'); }
            fs.cpSync(...args);
          } };
          if (name === 'node:path') return path;
          if (name === 'node:child_process') return { spawnSync(command: string, args: string[], options: any) {
            calls.push({ command, args, options });
            const stage = args[2]!; fs.mkdirSync(stage, { recursive: true });
            fs.writeFileSync(path.join(stage, 'package.json'), '{"scripts":{"build":"next build"}}');
            fs.writeFileSync(path.join(stage, 'README.md'), 'Generated README');
            fs.writeFileSync(path.join(stage, '.gitignore'), 'node_modules\n.next\n');
            fs.mkdirSync(path.join(stage, 'src')); fs.writeFileSync(path.join(stage, 'src', 'page.tsx'), 'app');
            return { status: 0 };
          } };
          throw new Error(`Unexpected module ${name}`);
        },
        process: { argv: ['node', repo, directory, id], env: {}, exit(code: number) { throw Object.assign(new Error('exit'), { code }); } },
      });
      return 0;
    } catch (error: any) { if ('code' in error) return error.code; throw error; }
  };
  return { root, repo, calls, run, crashOnCopy() { copyFailure = true; } };
}

test('controlled Next.js setup preserves a README-only repository, merges ignores, and replays without running npx twice', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'README.md'), 'User README');
  fs.writeFileSync(path.join(f.repo, '.gitignore'), 'secrets.env\n');
  assert.equal(f.run(), 0); assert.equal(f.run(), 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, 'npx');
  assert.equal(f.calls[0].args[1], 'create-next-app@16.3.6');
  for (const flag of ['--yes', '--skip-install', '--disable-git', '--use-npm']) assert.ok(f.calls[0].args.includes(flag));
  assert.equal(f.calls[0].options.env.CI, '1');
  assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), 'User README');
  assert.equal(fs.readFileSync(path.join(f.repo, '.gitignore'), 'utf8'), 'secrets.env\n\nnode_modules\n.next\n');
  assert.equal(fs.readFileSync(path.join(f.repo, 'src/page.tsx'), 'utf8'), 'app');
});

test('nested setup resumes a partially copied template using its saved merge intent', t => {
  const f = fixture(t); f.crashOnCopy();
  assert.throws(() => f.run('apps/web'), /crash/);
  assert.equal(f.run('apps/web'), 0);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(path.join(f.repo, 'apps/web/src/page.tsx'), 'utf8'), 'app');
});

test('setup refuses existing apps, unsafe paths, symlinks, and arbitrary command options', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'package.json'), 'original');
  assert.equal(f.run(), 20); assert.equal(f.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(f.repo, 'package.json'), 'utf8'), 'original');
  fs.mkdirSync(path.join(f.repo, 'nested', '.git'), { recursive: true });
  assert.equal(f.run('nested'), 20, 'do not scaffold inside a nested Git repository');
  fs.symlinkSync(f.root, path.join(f.repo, 'escape'), 'dir');
  assert.equal(f.run('escape'), 21);
  for (const directory of ['../escape', '/tmp/out', '.git', 'app/../../out', 'app;touch bad', 'a$(id)', '--help', 'a\\b', 'a//b']) {
    assert.equal(scaffoldInput.safeParse({ framework: 'nextjs', directory }).success, false, directory);
    assert.equal(f.run(directory), 21, directory);
  }
  assert.equal(scaffoldInput.safeParse({ framework: 'nextjs', directory: '.', command: 'sh' }).success, false);
});

test('setup failures are sanitized and the remote runner receives separate argv and bounded timeout', async () => {
  for (const [code, expected] of [[20, 'CONFLICT'], [21, 'PATH_DENIED'], [22, 'FAILED']] as const) {
    const session = { path: '/tmp/journey/repo', environment: async () => ({ CI: '1' }), commands: { async run(command: string, args: string[], options: any) {
      assert.equal(command, 'node'); assert.equal(args[0], '-e'); assert.equal(args[1], NEXT_SCAFFOLD_SCRIPT);
      assert.equal(args[3], 'apps/web'); assert.equal(options.timeoutMs, 720000);
      return { code, stdout: 'private provider message', stderr: '' };
    } } } as unknown as ExecutionWorkspace;
    await assert.rejects(scaffoldNextApp(session, randomUUID(), { framework: 'nextjs', directory: 'apps/web' }), new RegExp(`AGENT_SCAFFOLD_${expected}$`));
  }
});
