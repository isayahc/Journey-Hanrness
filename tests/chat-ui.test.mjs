import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the shipped controller, with controllable API replies and a minimal DOM.
class Element {
  constructor() {
    Object.assign(this, { hidden: false, disabled: false, value: '', textContent: '', children: [], elements: [], dataset: {}, className: '' });
    this.classList = { toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  focus() {}
  scrollIntoView() {}
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(data) });
async function fixture(t) {
  const elements = new Map(), chats = new Map(), requests = [], replies = new Map(), timers = new Set();
  const get = selector => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); };
  let createGate;
  const fetch = async (path, options = {}) => {
    requests.push({ path, options });
    if (path === '/api/status') return response({ authEnabled: true, githubAppEnabled: true, githubRepoSyncEnabled: true, agentJobsEnabled: true });
    if (path === '/api/me') return response({ githubLogin: 'ui-test' });
    if (path === '/api/github/installations') return response([{ installationId: 1 }]);
    if (path === '/api/github/repositories') return response([{ repositoryId: 1, fullName: 'ui-test/project', agentEnabled: true }]);
    if (path === '/api/agent-jobs') return response(options.method === 'POST' ? { jobId: 'test-job' } : []);
    if (path === '/api/chats') {
      if (options.method !== 'POST') return response([...chats.values()]);
      if (createGate) await createGate;
      const chat = { id: `chat-${chats.size + 1}`, title: `Conversation ${chats.size + 1}`, messages: [], version: 0 };
      chats.set(chat.id, chat); return response(chat);
    }
    const [, id, action] = /^\/api\/chats\/([^/]+)(?:\/(messages|cancel))?$/.exec(path) || [];
    const chat = chats.get(id);
    assert.ok(chat, `Unknown request ${path}`);
    if (action === 'messages') return new Promise((resolve, reject) => {
      const content = JSON.parse(options.body).content;
      replies.set(id, {
        succeed() { chat.messages.push({ role: 'user', content }, { role: 'assistant', content: `Answer for ${content}` }); chat.version++; resolve(response(chat)); },
        fail(code) { resolve(response({ error: 'Test reply failed', code }, code === 'CHAT_CANCELLED' ? 409 : 502)); },
        timeout() { reject(new DOMException('Timed out', 'TimeoutError')); },
      });
    });
    if (action === 'cancel') { replies.get(id)?.fail('CHAT_CANCELLED'); return response({ cancelled: true }); }
    return response(chat);
  };
  get('#agent-job-form').elements = ['#agent-repository', '#agent-instruction', '#submit-agent-job'].map(get);
  const context = vm.createContext({
    document: { querySelector: get, querySelectorAll: () => [], createElement: () => new Element(), createTextNode: text => ({ textContent: text }) },
    fetch, URLSearchParams, AbortSignal, Date, window: { location: { search: '', assign() {} } },
    setInterval(fn, ms) { const id = setInterval(fn, ms); timers.add(id); return id; },
    clearInterval(id) { clearInterval(id); timers.delete(id); },
    setTimeout(fn, ms) { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout(id) { clearTimeout(id); timers.delete(id); },
  });
  t.after(() => { for (const id of timers) clearInterval(id); });
  vm.runInContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await tick();
  return {
    get, requests, replies, chats,
    type(content) { get('#message').value = content; get('#message').oninput(); },
    send(content) { this.type(content); return get('#composer').onsubmit({ preventDefault() {} }); },
    async select(id) { const chat = chats.get(id); await get('#history').children.find(button => button.title === chat.title).onclick(); },
    delayCreation() { return new Promise(resolve => { createGate = new Promise(release => resolve(release)); }); },
    messages() { return get('#messages').children.map(message => message.children.map(child => child.textContent).join(' ')); },
  };
}

test('sending clears the composer immediately, shows one pending bubble, and keeps navigation enabled', async t => {
  const ui = await fixture(t);
  const release = await ui.delayCreation();
  const sent = ui.send('what repos do we have access to?');
  assert.equal(ui.get('#message').value, '', 'cleared before chat creation returns');
  assert.equal(ui.messages().length, 1);
  assert.equal(ui.get('#thinking').hidden, false);
  assert.equal(ui.get('#stop').disabled, true, 'cannot stop until the chat exists');
  for (const id of ['#new-chat', '#repositories-button', '#logout']) assert.equal(ui.get(id).disabled, false);
  release(); await tick();
  assert.equal(ui.get('#stop').disabled, false);
  await ui.get('#composer').onsubmit({ preventDefault() {} });
  assert.equal(ui.requests.filter(request => request.path.endsWith('/messages')).length, 1, 'double submits are ignored');
  ui.replies.get('chat-1').succeed(); await sent;
  assert.equal(ui.messages().length, 2);
  assert.equal(ui.get('#message').value, '');
  assert.equal(ui.get('#thinking').hidden, true);
  assert.equal(ui.get('#stop').hidden, true);
  assert.equal(ui.get('#send').disabled, false);
});

test('background replies and failures do not replace another chat or its draft', async t => {
  const ui = await fixture(t);
  const first = ui.send('First question'); await tick();
  ui.get('#new-chat').onclick();
  assert.equal(ui.get('#thinking').hidden, true);
  assert.equal(ui.get('#send').disabled, false);
  const second = ui.send('Second question'); await tick();
  ui.replies.get('chat-1').succeed(); await first;
  assert.match(ui.messages().join(' '), /Second question/);
  assert.doesNotMatch(ui.messages().join(' '), /First question/);
  assert.equal(ui.get('#thinking').hidden, false);
  await ui.select('chat-1');
  ui.type('Unsent draft in first chat');
  ui.replies.get('chat-2').fail(); await second;
  assert.equal(ui.get('#message').value, 'Unsent draft in first chat');
  assert.equal(ui.get('#error').hidden, true);
  await ui.select('chat-2');
  assert.equal(ui.get('#message').value, 'Second question');
  assert.match(ui.get('#error').textContent, /Test reply failed/);
  const retried = ui.get('#composer').onsubmit({ preventDefault() {} }); await tick();
  ui.replies.get('chat-2').succeed(); await retried;
  assert.equal(ui.chats.get('chat-2').messages.length, 2);
  await ui.select('chat-1');
  assert.equal(ui.get('#message').value, 'Unsent draft in first chat');
});

test('leaving while chat creation is pending does not overwrite the new chat draft', async t => {
  const ui = await fixture(t);
  const release = await ui.delayCreation();
  const sent = ui.send('Background creation');
  ui.get('#new-chat').onclick(); ui.type('New draft');
  release(); await tick();
  assert.equal(ui.get('#message').value, 'New draft');
  assert.equal(ui.get('#thinking').hidden, true);
  ui.replies.get('chat-1').fail(); await sent;
  assert.equal(ui.get('#message').value, 'New draft');
  await ui.select('chat-1');
  assert.equal(ui.get('#message').value, 'Background creation');
});

test('Stop targets the visible conversation and restores its message for retry', async t => {
  const ui = await fixture(t);
  const first = ui.send('First'); await tick();
  ui.get('#new-chat').onclick();
  const second = ui.send('Second'); await tick();
  await ui.select('chat-1');
  await ui.get('#stop').onclick(); await first;
  assert.equal(ui.requests.filter(request => request.path.endsWith('/cancel'))[0].path, '/api/chats/chat-1/cancel');
  assert.equal(ui.get('#thinking').hidden, true);
  assert.equal(ui.get('#message').value, 'First');
  assert.match(ui.get('#error').textContent, /Reply stopped/);
  await ui.select('chat-2');
  assert.equal(ui.get('#thinking').hidden, false);
  ui.replies.get('chat-2').succeed(); await second;
});

test('a timed-out request has a deadline, requests cancellation, and keeps the draft', async t => {
  const ui = await fixture(t);
  const sent = ui.send('Slow reply'); await tick();
  assert.ok(ui.requests.find(request => request.path.endsWith('/messages')).options.signal instanceof AbortSignal);
  ui.replies.get('chat-1').timeout(); await sent;
  assert.equal(ui.get('#thinking').hidden, true);
  assert.equal(ui.get('#send').disabled, false);
  assert.equal(ui.get('#message').value, 'Slow reply');
  assert.match(ui.get('#error').textContent, /timed out/);
  assert.ok(ui.requests.some(request => request.path.endsWith('/cancel')));
});


test('repository job controls remain usable while a chat reply is pending', async t => {
  const ui = await fixture(t);
  const sent = ui.send('Pending chat'); await tick();
  await ui.get('#repositories-button').onclick();
  assert.equal(ui.get('#submit-agent-job').disabled, false);
  ui.get('#agent-repository').value = '1';
  ui.get('#agent-instruction').value = 'Add a test';
  await ui.get('#agent-job-form').onsubmit({ preventDefault() {} });
  assert.ok(ui.requests.some(request => request.path === '/api/agent-jobs' && request.options.method === 'POST'));
  await ui.get('#repositories-button').onclick();
  assert.equal(ui.get('#thinking').hidden, false);
  ui.replies.get('chat-1').succeed(); await sent;
});
