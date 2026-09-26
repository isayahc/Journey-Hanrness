import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium, expect } from '@playwright/test';
import { createChatApp } from '../src/chat/app.ts';
import { MemoryChatStore } from '../src/chat/store.ts';

test('assistant Markdown renders safely and persists across reloads on mobile', { timeout: 30000 }, async () => {
  const content = '# Overview\n\n**Bold** and *italic* with [source](https://example.com).\n\n- Item\n- [x] Done\n\n> Quote\n\n```python\nprint("<safe>")\n' + 'x'.repeat(200) + '\n```\n\n| Name | Value |\n| --- | --- |\n| Row | 42 |\n\n<script>window.pwned = true</script><img src=x onerror="window.pwned=true"><a href="javascript:alert(1)">bad</a><iframe src="https://example.com"></iframe>';
  const provider = { async reply() { return { content }; } };
  let app, base;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
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
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('**literal input**');
    await composer.press('Enter');
    const markdown = page.locator('.message.assistant .markdown');
    await expect(markdown.locator('h1')).toHaveText('Overview');
    await expect(markdown.locator('strong')).toHaveText('Bold');
    await expect(markdown.locator('em')).toHaveText('italic');
    await expect(markdown.locator('blockquote')).toContainText('Quote');
    await expect(markdown.locator('pre code')).toContainText('print("<safe>")');
    await expect(markdown.locator('td')).toHaveText(['Row', '42']);
    await expect(markdown.locator('input')).toBeChecked();
    await expect(markdown.locator('input')).toBeDisabled();
    await expect(markdown.getByRole('link', { name: 'source' })).toHaveAttribute('rel', 'noopener noreferrer');
    assert.equal(await markdown.locator('script, img, iframe, [onerror], a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    await expect(page.locator('.message.user .markdown strong')).toHaveText('literal input');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.reload();
    await page.getByRole('button', { name: '**literal input**', exact: true }).click();
    await expect(markdown.locator('h1')).toHaveText('Overview');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
