import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { stop } from '../scripts/runtime.mjs';

// CI uses a disposable MongoDB database and a deterministic model fixture.
// Without MONGODB_TEST_URI this verifies the visibly labeled in-memory demo UI.
test('goals UI creates a plan, reloads, isolates owners, and survives a MongoDB app restart', { timeout: 60_000 }, async () => {
  const databaseName = `journey_ui_${crypto.randomUUID().replaceAll('-', '')}`;
  const mongo = process.env.MONGODB_TEST_URI ? new MongoClient(process.env.MONGODB_TEST_URI) : null;
  const model = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/session') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'test-planning-session' })); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    const task = JSON.parse(request.parts[0].text);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ info: {}, parts: [{ type: 'text', text: JSON.stringify({
      summary: 'Prepare and verify the demo checklist',
      steps: [{ id: 'prepare', title: 'Prepare the checklist', instruction: task.goal, dependsOn: [], verification: task.successCriteria.join('; ') }],
    }) }] }));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const portHolder = createServer(); portHolder.listen(0, '127.0.0.1'); await once(portHolder, 'listening');
  const port = portHolder.address().port;
  await new Promise(resolve => portHolder.close(resolve));
  const base = `http://localhost:${port}`;
  let app, browser;
  let logs = '';
  async function startApp() {
    app = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts', ...(mongo ? [] : ['--demo'])], {
      env: { ...process.env, PORT: String(port), APP_ORIGIN: base,
        OPENCODE_URL: `http://127.0.0.1:${model.address().port}`, OPENCODE_MODEL: 'opencode/space-bunny-free',
        OPENCODE_SERVER_PASSWORD: '', MONGODB_URI: process.env.MONGODB_TEST_URI || '', MONGODB_DB: databaseName,
        GITHUB_APP_CLIENT_ID: '', GITHUB_APP_CLIENT_SECRET: '', GITHUB_APP_SLUG: '', GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '', GITHUB_APP_WEBHOOK_SECRET: '',
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    app.stdout.on('data', chunk => { logs += chunk; });
    app.stderr.on('data', chunk => { logs += chunk; });
    for (let i = 0; i < 80; i++) {
      if (app.exitCode !== null) throw new Error(`App stopped: ${logs}`);
      try { if ((await fetch(`${base}/api/status`)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`App did not start: ${logs}`);
  }
  try {
    if (mongo) await mongo.connect();
    await startApp();
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.getByRole('link', { name: 'Goals & plans' }).click();
    await page.getByLabel('Goal', { exact: true }).fill('Prepare a five-minute product demo');
    await page.getByLabel('Success criteria').fill('Include a setup checklist\nInclude an offline fallback');
    await page.getByRole('button', { name: 'Save goal & generate plan' }).click();
    await page.getByText('Plan saved · Ready for review', { exact: true }).waitFor();
    assert.equal(await page.locator('#run-criteria li').count(), 2);
    assert.equal(await page.locator('#plan-steps li').count(), 1);
    assert.match(await page.locator('#run-metadata').innerText(), /opencode\/space-bunny-free/);
    const savedUrl = page.url();
    const id = new URL(savedUrl).searchParams.get('run');
    assert.ok(id);
    await page.reload();
    await page.getByText('Plan saved · Ready for review', { exact: true }).waitFor();
    assert.equal(await page.locator('#run-title').innerText(), 'Prepare a five-minute product demo');
    const other = await browser.newContext();
    const response = await other.request.get(`${base}/api/runs/${id}`);
    assert.equal(response.status(), 404);
    await other.close();
    if (mongo) {
      await stop(app); await startApp();
      await page.goto(savedUrl);
      await page.getByText('Plan saved · Ready for review', { exact: true }).waitFor();
      assert.equal(await page.locator('#run-criteria li').count(), 2);
      const record = await mongo.db(databaseName).collection('goal_runs').findOne({ id });
      assert.equal(record.status, 'planned');
      assert.equal(record.planningAttempts, 1);
      assert.equal(record.model, 'opencode/space-bunny-free');
    }
    await page.screenshot({ path: 'goal-plan-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: 'goal-plan-mobile.png', fullPage: true });
    await page.getByRole('link', { name: 'Back to chat' }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stop(app);
    await new Promise(resolve => model.close(resolve));
    if (mongo) {
      try { await mongo.db(databaseName).dropDatabase(); } finally { await mongo.close(); }
    }
  }
});
