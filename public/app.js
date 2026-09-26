const $ = selector => document.querySelector(selector);
let current = null;
let initializing = true;
let loadingChat = false;
let syncingRepositories = false;
let navigationVersion = 0;
let historyVersion = 0;
let draftNumber = 0;
let activeKey = 'draft-0';
const drafts = new Map();
const pendingReplies = new Map();
const chatErrors = new Map();
let authBlocked = false;
let repositoryMode = false;
let githubRepoSyncEnabled = false;
let agentJobsEnabled = false;
let jobPending = false;
let jobsLoading = false;
let jobsTimer;
let enabledRepositories = [];


async function api(path, body, timeout = 15000) {
  const response = await fetch(path, {
    signal: AbortSignal.timeout(timeout),
    ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
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
  const body = document.createElement('div');
  body.className = 'message-content';
  if (message.role === 'assistant') renderMarkdown(body, message.content);
  else body.textContent = message.content;
  article.append(speaker, body);
  $('#messages').append(article);
}
function render() {
  $('#messages').replaceChildren();
  for (const message of current?.messages || []) renderMessage(message);
  const pending = pendingReplies.get(activeKey);
  if (pending) renderMessage({ role: 'user', content: pending.content }, true);
  $('#welcome').hidden = authBlocked || repositoryMode || !!current?.messages.length || !!pending;
  $('#message').value = drafts.get(activeKey) || '';
  $('#error').hidden = !chatErrors.has(activeKey);
  $('#error').textContent = chatErrors.get(activeKey) || '';
  updateControls();
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
  updateControls();
}
function setRepositoryMode(value) {
  repositoryMode = value;
  $('#repo-panel').hidden = !value;
  $('#chat-workspace').hidden = value || authBlocked;
  $('#workspace-title').textContent = value ? 'Repositories' : 'Chat';
  $('#repositories-button').textContent = value ? '← Back to chat' : 'Repositories';
  clearTimeout(jobsTimer);
  if (!value) render();
}
async function refreshHistory() {
  const version = ++historyVersion;
  const chats = await api('/api/chats');
  if (version !== historyVersion) return chats;
  $('#history').replaceChildren();
  for (const chat of chats) {
    const button = document.createElement('button');
    button.textContent = chat.title; button.title = chat.title;
    button.setAttribute('aria-current', String(chat.id === current?.id));
    button.disabled = initializing || authBlocked;
    button.onclick = async () => {
      if (initializing || authBlocked) return;
      const selection = ++navigationVersion;
      drafts.set(activeKey, $('#message').value);
      activeKey = chat.id;
      current = { ...chat, messages: [] };
      loadingChat = true;
      setRepositoryMode(false);
      try {
        const loaded = await api(`/api/chats/${chat.id}`);
        if (selection !== navigationVersion) return;
        if (!(current?.version > loaded.version)) current = loaded;
      } catch (error) {
        if (selection === navigationVersion) chatErrors.set(chat.id, error.message);
      } finally {
        if (selection === navigationVersion) { loadingChat = false; render(); }
      }
      await refreshHistory().catch(showError);
    };
    $('#history').append(button);
  }
  return chats;
}
function renderRepositories(repositories) {
  enabledRepositories = repositories.filter(repository => repository.agentEnabled && !repository.archived);
  const selected = $('#agent-repository').value;
  $('#agent-repository').replaceChildren(...enabledRepositories.map(repository => {
    const option = document.createElement('option');
    option.value = String(repository.repositoryId); option.textContent = repository.fullName;
    return option;
  }));
  if (enabledRepositories.some(repository => String(repository.repositoryId) === selected)) $('#agent-repository').value = selected;
  updateJobControls();
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
  await loadAgentJobs();
  return repositories;
}
function updateControls() {
  const blocked = initializing || authBlocked;
  const pending = pendingReplies.get(activeKey);
  $('#new-chat').disabled = blocked;
  $('#repositories-button').disabled = blocked;
  $('#message').disabled = blocked || loadingChat || !!pending;
  $('#send').disabled = blocked || loadingChat || !!pending;
  $('#sync-repositories').disabled = blocked || syncingRepositories || !githubRepoSyncEnabled;
  $('#logout').disabled = initializing;
  for (const button of $('#history').children) button.disabled = blocked;
  $('#stop').hidden = !pending;
  $('#stop').disabled = blocked || !pending?.chatId || !!pending?.stopping;
  $('#thinking').hidden = !pending || authBlocked || repositoryMode;
  if (pending) {
    const seconds = Math.floor((Date.now() - pending.startedAt) / 1000);
    const status = pending.stopping ? 'Stopping…'
      : seconds < 15 ? 'Thinking…' : 'Still working… You can stop this reply or open another chat.';
    if ($('#thinking').textContent !== status) $('#thinking').textContent = status;
  }
  $('#messages').setAttribute('aria-busy', String(!!pending));
  updateJobControls();
}
$('#message').oninput = () => drafts.set(activeKey, $('#message').value);
$('#new-chat').onclick = () => {
  if (initializing || authBlocked) return;
  ++navigationVersion;
  drafts.set(activeKey, $('#message').value);
  activeKey = `draft-${++draftNumber}`;
  loadingChat = false;
  current = null;
  setRepositoryMode(false);
  void refreshHistory().catch(showError);
  $('#message').focus();
};
$('#repositories-button').onclick = async () => {
  if (initializing || authBlocked) return;
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
  if (!githubRepoSyncEnabled || initializing || authBlocked || syncingRepositories) return;
  $('#repo-sync-note').hidden = true;
  syncingRepositories = true; updateControls();
  try {
    const repositories = await api('/api/github/repositories/sync', {}, 90000);
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
  } finally { syncingRepositories = false; updateControls(); }
};
for (const button of document.querySelectorAll('[data-prompt]')) button.onclick = () => {
  if (initializing || authBlocked || pendingReplies.has(activeKey)) return;
  $('#message').value = button.dataset.prompt; drafts.set(activeKey, button.dataset.prompt); $('#message').focus();
};
$('#message').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); if (!initializing && !loadingChat && !authBlocked && !pendingReplies.has(activeKey)) $('#composer').requestSubmit();
  }
};
$('#composer').onsubmit = async event => {
  event.preventDefault();
  const content = $('#message').value.trim();
  if (!content || initializing || loadingChat || authBlocked || pendingReplies.has(activeKey)) return;
  let key = activeKey;
  let chat = current;
  const operation = { content, chatId: chat?.id, startedAt: Date.now(), stopping: false };
  pendingReplies.set(key, operation);
  drafts.set(key, '');
  chatErrors.delete(key);
  render();
  $('#thinking').scrollIntoView({ block: 'nearest' });
  const timer = setInterval(updateControls, 1000);
  try {
    if (!chat) {
      chat = await api('/api/chats', {});
      operation.chatId = chat.id;
      pendingReplies.delete(key);
      pendingReplies.set(chat.id, operation);
      drafts.delete(key);
      if (activeKey === key) { activeKey = chat.id; current = chat; render(); }
      key = chat.id;
      void refreshHistory().catch(() => {});
    }
    const result = await api(`/api/chats/${chat.id}/messages`, { content }, 105000);
    if (activeKey === key) current = result;
  } catch (error) {
    let recovered = false;
    if (error.name === 'TimeoutError' && chat) {
      // A lost response may already have been saved. Reconcile before offering a retry.
      await api(`/api/chats/${chat.id}/cancel`, {}).catch(() => {});
      try {
        const latest = await api(`/api/chats/${chat.id}`);
        recovered = latest.version > chat.version;
        if (activeKey === key) current = latest;
      } catch { /* Keep the user's draft if recovery is unavailable. */ }
    }
    if (!recovered) {
      drafts.set(key, content);
      chatErrors.set(key, error.code === 'CHAT_CANCELLED'
        ? 'Reply stopped. Your message is ready to send again.'
        : error.name === 'TimeoutError' ? 'The request timed out. Check the conversation before retrying. Your message has been kept.' : error.message);
    }
  } finally {
    clearInterval(timer);
    pendingReplies.delete(key);
    if (activeKey === key) { render(); if (!repositoryMode) $('#message').focus(); }
    await refreshHistory().catch(() => {});
  }
};
$('#stop').onclick = async () => {
  const key = activeKey;
  const operation = pendingReplies.get(key);
  if (!operation?.chatId || operation.stopping) return;
  operation.stopping = true; updateControls();
  try {
    const result = await api(`/api/chats/${operation.chatId}/cancel`, {});
    if (!result.cancelled && pendingReplies.get(key) === operation) {
      operation.stopping = false;
      chatErrors.set(key, 'The reply is starting or has just finished. Try Stop again if it is still running.');
      if (activeKey === key) render();
    }
  }
  catch (error) {
    if (pendingReplies.get(key) !== operation) return;
    operation.stopping = false;
    chatErrors.set(key, `Could not stop the reply: ${error.message}`);
    if (activeKey === key) render();
  }
};
$('#logout').onclick = async () => {
  if (initializing) return;
  try { await api('/auth/logout', {}); window.location.assign('/'); }
  catch (error) { showError(error); }
};
async function init() {
  initializing = true; updateControls();
  try {
    const status = await api('/api/status');
    githubRepoSyncEnabled = !!status.githubRepoSyncEnabled;
    agentJobsEnabled = !!status.agentJobsEnabled;
    $('#mode').textContent = status.demo ? 'Demo · No AI connected' : status.webSearch?.configured ? 'OpenCode · Tavily' : 'OpenCode · Search off';
    const params = new URLSearchParams(window.location.search);
    const authProblem = params.get('auth');
    const githubResult = params.get('github');
    if (status.authEnabled) {
      const meResponse = await fetch('/api/me', { signal: AbortSignal.timeout(15000) });
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
    if (chats.length) { current = await api(`/api/chats/${chats[0].id}`); activeKey = current.id; }
    render();
    if (githubResult === 'connected' && status.githubAppEnabled) {
      setRepositoryMode(true);
      await loadRepositories();
    }
  } catch (error) { showError(error); $('#mode').textContent = 'Unavailable'; }
  finally { initializing = false; updateControls(); }
}
/** Keep job controls independent of chat requests and repository sync. */
function updateJobControls() {
  const blocked = initializing || authBlocked || jobPending || !agentJobsEnabled;
  for (const element of $('#agent-job-form').elements) element.disabled = blocked || !enabledRepositories.length;
  $('#refresh-agent-jobs').disabled = blocked || jobsLoading;
  for (const element of document.querySelectorAll('[data-job-action]')) element.disabled = blocked;
  $('#agent-job-note').textContent = !agentJobsEnabled
    ? 'Repository agent execution is not configured for this deployment.'
    : !enabledRepositories.length ? 'Enable agent access on a repository above to start a job.' : 'Jobs run in the background. Status refreshes automatically while this page is open.';
}
function jobError(error) {
  $('#agent-job-error').textContent = error.message;
  $('#agent-job-error').hidden = false;
}
/** Render untrusted job output as text; only allow GitHub pull-request links. */
function renderAgentJobs(jobs) {
  const list = $('#agent-job-list');
  list.replaceChildren();
  if (!jobs.length) { list.textContent = 'No agent jobs yet.'; return; }
  for (const job of jobs) {
    const card = document.createElement('article'); card.className = 'agent-job-card';
    const heading = document.createElement('h4'); heading.textContent = job.repositoryFullName || `Repository ${job.repositoryId}`;
    card.append(heading);
    for (const text of [job.request, `Status: ${job.status} · Checkpoint: ${job.checkpoint || 'Not started'}`, `Job: ${job.jobId}`, job.branch && `Branch: ${job.branch}`, job.summary && `Summary: ${job.summary}`, job.failure && `Failure: ${job.failure}`]) {
      if (!text) continue;
      const paragraph = document.createElement('p'); paragraph.textContent = text; card.append(paragraph);
    }
    const checks = document.createElement('ul');
    for (const check of job.checks || []) {
      const item = document.createElement('li'); item.textContent = `${check.ok ? 'PASS' : 'FAIL'}: ${check.command}`; checks.append(item);
    }
    if (!checks.children.length) { const item = document.createElement('li'); item.textContent = 'No checks reported yet.'; checks.append(item); }
    card.append(checks);
    if (job.pullRequestUrl && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(job.pullRequestUrl)) {
      const link = document.createElement('a'); link.href = job.pullRequestUrl; link.textContent = 'View pull request'; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
    }
    const active = ['queued', 'running', 'failed'].includes(job.status);
    if (active) {
      const actions = document.createElement('div'); actions.className = 'repo-actions';
      for (const action of ['resume', 'cancel']) {
        if (action === 'resume' && job.leaseUntil && new Date(job.leaseUntil) > new Date()) continue;
        const button = document.createElement('button'); button.type = 'button'; button.dataset.jobAction = action;
        button.textContent = action === 'resume' ? 'Resume job' : 'Cancel job';
        button.onclick = () => actOnJob(job.jobId, action); actions.append(button);
      }
      card.append(actions);
    }
    list.append(card);
  }
  updateJobControls();
}
/** Fetch persisted owner-scoped history without overlapping polling requests. */
async function loadAgentJobs() {
  if (!agentJobsEnabled || jobsLoading) return;
  clearTimeout(jobsTimer); jobsLoading = true; updateJobControls();
  try {
    const jobs = await api('/api/agent-jobs');
    renderAgentJobs(jobs);
    $('#agent-job-updates').textContent = `${jobs.length} jobs loaded.`;
  } catch (error) { jobError(error); }
  finally {
    jobsLoading = false; updateJobControls();
    if (repositoryMode && !authBlocked) jobsTimer = setTimeout(loadAgentJobs, 5000);
  }
}
async function actOnJob(jobId, action) {
  if (jobPending || initializing || authBlocked) return;
  jobPending = true; updateJobControls(); $('#agent-job-error').hidden = true;
  try { await api(`/api/agent-jobs/${jobId}/${action}`, {}); await loadAgentJobs(); }
  catch (error) { jobError(error); }
  finally { jobPending = false; updateJobControls(); }
}
$('#refresh-agent-jobs').onclick = loadAgentJobs;
$('#agent-job-form').onsubmit = async event => {
  event.preventDefault();
  const instruction = $('#agent-instruction').value.trim();
  const repositoryId = Number($('#agent-repository').value);
  if (jobPending || initializing || authBlocked || !agentJobsEnabled || !instruction || !enabledRepositories.some(repository => repository.repositoryId === repositoryId)) return;
  jobPending = true; updateJobControls(); $('#agent-job-error').hidden = true;
  try {
    await api('/api/agent-jobs', { repositoryId, instruction });
    $('#agent-instruction').value = '';
    await loadAgentJobs();
  } catch (error) { jobError(error); }
  finally { jobPending = false; updateJobControls(); }
};
init();
