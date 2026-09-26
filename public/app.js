const $ = selector => document.querySelector(selector);
let current = null;
let busy = false;
let authBlocked = false;
let repositoryMode = false;
let githubRepoSyncEnabled = false;

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong. Please try again.');
    error.code = data.code;
    throw error;
  }
  return data;
}
function showError(error) { $('#error').textContent = error.message; $('#error').hidden = false; }
function showGitHubStatus(code) {
  const messages = {
    connected: ['GitHub repositories connected. You can update the selected repositories from GitHub at any time.', false],
    requested: ['GitHub installation access was requested and is waiting for an organization owner to approve it.', false],
    denied: ['GitHub authorization was cancelled. No repository access was saved.', true],
    unauthorized: ['That GitHub App installation is not accessible to the signed-in GitHub account.', true],
    'account-mismatch': ['The GitHub account used to verify the installation does not match your journey-harness account.', true],
    permissions: ['The GitHub App installation is missing required permissions: Metadata read, Contents write, and Pull requests write.', true],
    signin: ['Sign in to journey-harness before connecting repositories.', true],
    unavailable: ['GitHub App installation is not configured for this deployment.', true],
    failed: ['GitHub repository connection could not be verified. Please try again.', true],
  };
  const item = messages[code];
  if (!item) return;
  $('#github-status').textContent = item[0];
  $('#github-status').classList.toggle('error', item[1]);
  $('#github-status').hidden = false;
}
function renderMessage(message, pending = false) {
  const article = document.createElement('article');
  article.className = `message ${message.role}${pending ? ' pending' : ''}`;
  const speaker = document.createElement('span');
  speaker.className = 'speaker'; speaker.textContent = message.role === 'user' ? 'YOU' : 'journey-harness';
  article.append(speaker, document.createTextNode(message.content));
  $('#messages').append(article);
}
function render() {
  $('#messages').replaceChildren();
  for (const message of current?.messages || []) renderMessage(message);
  $('#welcome').hidden = authBlocked || repositoryMode || !!current?.messages.length;
}
function setAuthBlocked(value, message) {
  authBlocked = value;
  $('#auth-gate').hidden = !value;
  $('#chat-workspace').hidden = value || repositoryMode;
  if (value) {
    current = null;
    $('#history').replaceChildren();
    $('#welcome').hidden = true;
    if (message) $('#auth-message').textContent = message;
  }
  setBusy(busy);
}
function setRepositoryMode(value) {
  repositoryMode = value;
  $('#repo-panel').hidden = !value;
  $('#chat-workspace').hidden = value || authBlocked;
  $('#workspace-title').textContent = value ? 'Repositories' : 'Chat';
  $('#repositories-button').textContent = value ? '← Back to chat' : 'Repositories';
  if (!value) render();
}
async function refreshHistory() {
  const chats = await api('/api/chats');
  $('#history').replaceChildren();
  for (const chat of chats) {
    const button = document.createElement('button');
    button.textContent = chat.title; button.title = chat.title;
    button.setAttribute('aria-current', String(chat.id === current?.id));
    button.disabled = busy || authBlocked;
    button.onclick = async () => {
      if (busy || authBlocked) return;
      setRepositoryMode(false);
      try { current = await api(`/api/chats/${chat.id}`); render(); await refreshHistory(); }
      catch (error) { showError(error); }
    };
    $('#history').append(button);
  }
  return chats;
}
function renderRepositories(repositories) {
  $('#repository-list').replaceChildren();
  if (!repositories.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-repositories';
    empty.textContent = 'No repositories are synced yet. Connect or update the GitHub App installation, then sync.';
    $('#repository-list').append(empty);
    return;
  }
  for (const repository of repositories) {
    const row = document.createElement('article');
    row.className = 'repository-row';

    const info = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = repository.fullName;
    const meta = document.createElement('span');
    meta.textContent = `${repository.private ? 'Private' : 'Public'} · default: ${repository.defaultBranch}${repository.archived ? ' · Archived' : ''}`;
    info.append(name, meta);

    const control = document.createElement('button');
    control.type = 'button';
    control.className = repository.agentEnabled ? 'agent-toggle enabled' : 'agent-toggle';
    control.textContent = repository.archived
      ? 'Archived'
      : repository.agentEnabled ? 'Agent access on' : 'Enable agent access';
    control.disabled = repository.archived;
    if (repository.archived) control.dataset.alwaysDisabled = 'true';
    control.onclick = async () => {
      control.disabled = true;
      try {
        const updated = await api(`/api/github/repositories/${repository.repositoryId}/agent-access`, { enabled: !repository.agentEnabled });
        repository.agentEnabled = updated.agentEnabled;
        renderRepositories(repositories);
      } catch (error) {
        $('#repo-sync-note').textContent = error.message;
        $('#repo-sync-note').hidden = false;
        control.disabled = false;
      }
    };
    row.append(info, control);
    $('#repository-list').append(row);
  }
}
async function loadRepositories() {
  const repositories = await api('/api/github/repositories');
  renderRepositories(repositories);
  return repositories;
}
function setBusy(value) {
  busy = value;
  for (const element of document.querySelectorAll('button, textarea')) element.disabled = value || authBlocked;
  for (const element of document.querySelectorAll('[data-always-disabled="true"]')) element.disabled = true;
  $('#sync-repositories').disabled = value || authBlocked || !githubRepoSyncEnabled;
  $('#logout').disabled = value;
  $('#thinking').hidden = !value;
}
$('#new-chat').onclick = async () => {
  if (busy || authBlocked) return;
  setRepositoryMode(false);
  current = null; render(); $('#error').hidden = true; $('#message').value = '';
  try { await refreshHistory(); } catch (error) { showError(error); }
  $('#message').focus();
};
$('#repositories-button').onclick = async () => {
  if (busy || authBlocked) return;
  setRepositoryMode(!repositoryMode);
  if (repositoryMode) {
    try { await loadRepositories(); }
    catch (error) {
      $('#repo-sync-note').textContent = error.message;
      $('#repo-sync-note').hidden = false;
    }
  }
};
$('#sync-repositories').onclick = async () => {
  if (!githubRepoSyncEnabled || busy) return;
  $('#repo-sync-note').hidden = true;
  setBusy(true);
  try {
    const repositories = await api('/api/github/repositories/sync', {});
    renderRepositories(repositories);
    $('#repo-sync-note').textContent = repositories.length
      ? 'Repository access refreshed from GitHub.'
      : 'GitHub is connected, but no repositories are available. Check your selected repositories under Change GitHub access.';
    $('#repo-sync-note').hidden = false;
  } catch (error) {
    if (error.code === 'GITHUB_CONNECTION_REQUIRED') {
      window.location.assign('/github/connect');
      return;
    }
    $('#repo-sync-note').textContent = error.message;
    $('#repo-sync-note').hidden = false;
  } finally { setBusy(false); }
};
for (const button of document.querySelectorAll('[data-prompt]')) button.onclick = () => {
  $('#message').value = button.dataset.prompt; $('#message').focus();
};
$('#message').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); if (!busy && !authBlocked) $('#composer').requestSubmit();
  }
};
$('#composer').onsubmit = async event => {
  event.preventDefault();
  const content = $('#message').value.trim();
  if (!content || busy || authBlocked) return;
  $('#error').hidden = true; setBusy(true);
  try {
    if (!current) current = await api('/api/chats', {});
    $('#welcome').hidden = true; renderMessage({ role: 'user', content }, true);
    $('#thinking').scrollIntoView({ block: 'nearest' });
    current = await api(`/api/chats/${current.id}/messages`, { content });
    $('#message').value = ''; render();
  } catch (error) { render(); showError(error); }
  finally {
    setBusy(false);
    try { await refreshHistory(); } catch (error) { showError(error); }
    $('#message').focus();
  }
};
$('#logout').onclick = async () => {
  if (busy) return;
  try { await api('/auth/logout', {}); window.location.assign('/'); }
  catch (error) { showError(error); }
};
async function init() {
  setBusy(true);
  try {
    const status = await api('/api/status');
    githubRepoSyncEnabled = !!status.githubRepoSyncEnabled;
    $('#mode').textContent = status.demo ? 'Demo · No AI connected' : status.webSearch?.configured ? 'OpenCode · Tavily' : 'OpenCode · Search off';
    const params = new URLSearchParams(window.location.search);
    const authProblem = params.get('auth');
    const githubResult = params.get('github');
    if (status.authEnabled) {
      const meResponse = await fetch('/api/me');
      if (meResponse.status === 401) {
        const message = authProblem === 'denied'
          ? 'GitHub sign-in was cancelled. You can try again when you are ready.'
          : authProblem === 'failed'
            ? 'GitHub sign-in could not be completed. Please try again.'
            : undefined;
        setAuthBlocked(true, message);
        $('#mode').textContent = 'Sign in required';
        if (githubResult) showGitHubStatus(githubResult);
        return;
      }
      const me = await meResponse.json();
      if (!meResponse.ok) throw new Error(me.error || 'Could not load your account.');
      setAuthBlocked(false);
      $('#account').textContent = `@${me.githubLogin}`;
      $('#account').hidden = false;
      $('#logout').hidden = false;
      if (status.githubAppEnabled) {
        $('#connect-github').hidden = false;
        $('#repositories-button').hidden = false;
        const installations = await api('/api/github/installations');
        if (installations.length) {
          $('#connect-github').textContent = `GitHub · ${installations.length} installation${installations.length === 1 ? '' : 's'}`;
          $('#connect-github').href = '/github/install';
        }
      }
      $('#sync-repositories').disabled = !githubRepoSyncEnabled;
      if (!githubRepoSyncEnabled) {
        $('#repo-sync-note').textContent = 'Add the GitHub App ID and private key to enable repository synchronization.';
        $('#repo-sync-note').hidden = false;
      }
      if (githubResult) showGitHubStatus(githubResult);
      $('#footnote').textContent = status.demo ? 'Demo replies only. Signed-in history resets when the server stops.' : 'History saved to your journey-harness account. AI can make mistakes.';
    } else {
      setAuthBlocked(false);
      $('#footnote').textContent = status.demo ? 'Demo replies only. History resets when the server stops.' : 'Local mode: history saved in MongoDB for this browser. AI can make mistakes.';
    }
    const chats = await refreshHistory();
    if (chats.length) current = await api(`/api/chats/${chats[0].id}`);
    render();
    if (githubResult === 'connected' && status.githubAppEnabled) {
      setRepositoryMode(true);
      await loadRepositories();
    }
  } catch (error) { showError(error); $('#mode').textContent = 'Unavailable'; }
  finally { setBusy(false); }
}
init();
