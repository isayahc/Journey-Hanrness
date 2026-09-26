import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium, expect } from '@playwright/test';
import { createChatApp } from '../src/chat/app.ts';
import { MemoryChatStore } from '../src/chat/store.ts';

test('chat clears sent text, keeps navigation available, and stops only the selected reply', { timeout: 30_000 }, async () => {
  const replies = new Map();
  const provider = {
    async reply(messages, _session, _version, _scope, options) {
      const content = messages.at(-1).content;
      return new Promise((resolve, reject) => {
        const finish = () => resolve({ content: `Answer for ${content}` });
        replies.set(content, finish);
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  };
  let releaseCreation;
  const creationGate = new Promise(resolve => { releaseCreation = resolve; });
  let app, base;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (req.method === 'POST' && req.url === '/api/chats') await creationGate;
      const response = await app(new Request(`${base}${req.url}`, {
        method: req.method, headers: req.headers, ...(body.length ? { body } : {}),
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  app = createChatApp(new MemoryChatStore(), provider, true, server.address().port);
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect(page.locator('#composer button')).toHaveCount(1);
    await expect(page.locator('#send')).toHaveAccessibleName('Send message');
    await composer.fill('First question');
    await page.locator('#send').click();
    await expect(composer).toHaveValue('');
    await expect(page.locator('#messages .message')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'New chat', exact: false })).toBeEnabled();
    await expect(page.locator('#composer button')).toHaveCount(1);
    await expect(page.locator('#send')).toHaveAccessibleName('Stop reply');
    await expect(page.locator('#send')).toHaveAttribute('type', 'button');
    await expect(page.locator('#send')).toBeDisabled();
    releaseCreation();
    await expect(page.locator('#send')).toBeEnabled();
    await expect.poll(() => replies.has('First question')).toBe(true);
    await page.screenshot({ path: 'chat-composer-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'New chat', exact: false }).click();
    await expect(page.locator('#thinking')).toBeHidden();
    await expect(page.locator('#send')).toHaveAccessibleName('Send message');
    await composer.fill('Second question'); await composer.press('Enter');
    await expect.poll(() => replies.has('Second question')).toBe(true);
    replies.get('First question')();
    await expect(page.getByRole('button', { name: 'First question', exact: true })).toBeVisible();
    await expect(page.locator('#messages')).not.toContainText('Answer for First question');
    await page.getByRole('button', { name: 'Stop reply' }).click();
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveValue('Second question');
    await expect(page.locator('#send')).toHaveAccessibleName('Send message');
    await expect(page.locator('#send')).toHaveAttribute('type', 'submit');
    await expect(page.getByRole('alert')).toContainText('Reply stopped');
    await page.getByRole('button', { name: 'First question', exact: true }).click();
    await expect(page.locator('#messages')).toContainText('Answer for First question');
    await expect(composer).toHaveValue('');
    await composer.fill('Mobile question'); await composer.press('Enter');
    await expect.poll(() => replies.has('Mobile question')).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: 'chat-composer-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Stop reply' }).click();
    await expect(composer).toBeEnabled();
    assert.deepEqual(errors, []);
  } finally {
    releaseCreation();
    for (const finish of replies.values()) finish();
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
