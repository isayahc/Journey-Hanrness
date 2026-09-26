import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

/** Load the exact scripts served to the browser into an isolated DOM. */
function fixture() {
  const dom = new JSDOM('<div id="message"></div>', { runScripts: 'outside-only' });
  for (const file of ['node_modules/marked/lib/marked.umd.js', 'node_modules/dompurify/dist/purify.min.js', 'public/markdown.js']) {
    dom.window.eval(readFileSync(file, 'utf8'));
  }
  return { dom, body: dom.window.document.querySelector('#message') };
}

test('Markdown renders GFM, escaped code, and safe external links', () => {
  const { dom, body } = fixture();
  try {
    dom.window.renderMarkdown(body, '# Title\n\n**bold** and *italic*\n\n- [x] Done\n\n> Quote\n\n```python\nprint("<safe>")\n```\n\n| Key | Value |\n| --- | --- |\n| A | 42 |\n\n[source](https://example.com)');
    assert.equal(body.querySelector('h1').textContent, 'Title');
    assert.equal(body.querySelector('strong').textContent, 'bold');
    assert.equal(body.querySelector('em').textContent, 'italic');
    assert.equal(body.querySelector('input').checked, true);
    assert.equal(body.querySelector('input').disabled, true);
    assert.match(body.querySelector('blockquote').textContent, /Quote/);
    assert.match(body.querySelector('pre code').textContent, /print\("<safe>"\)/);
    assert.equal(body.querySelector('.markdown-table table td').textContent, 'A');
    assert.equal(body.querySelector('a').rel, 'noopener noreferrer');
    dom.window.renderMarkdown(body, 'Replacement');
    assert.equal(body.textContent.trim(), 'Replacement');
  } finally { dom.window.close(); }
});

test('untrusted Markdown cannot inject active content or unsafe links', () => {
  const { dom, body } = fixture();
  try {
    dom.window.renderMarkdown(body, '<script>alert(1)</script><img src=x onerror=alert(1)><svg onload=alert(1)></svg><iframe src="https://example.com"></iframe><form><input type=password autofocus></form><p style="position:fixed" onclick="alert(1)">text</p>\n\n[bad](javascript:alert) [data](data:text/html,test) [relative](/api/logout) [protocol](//example.com)');
    assert.equal(body.querySelectorAll('script,img,svg,iframe,form,[onerror],[onload],[onclick],[style],[autofocus]').length, 0);
    assert.equal(body.querySelectorAll('a[href]').length, 0);
    assert.equal(body.querySelector('input').type, 'checkbox');
    assert.equal(body.querySelector('input').disabled, true);
  } finally { dom.window.close(); }
});

test('missing vendor assets fall back to readable plain text', () => {
  const { dom, body } = fixture();
  try {
    dom.window.marked = undefined;
    dom.window.renderMarkdown(body, '<script>unsafe</script> **raw**');
    assert.equal(body.textContent, '<script>unsafe</script> **raw**');
    assert.equal(body.children.length, 0);
  } finally { dom.window.close(); }
});
