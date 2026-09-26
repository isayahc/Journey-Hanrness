const $ = selector => document.querySelector(selector);
let selected = null;
let poll;
let saving = false;
let enabled = false;
const pending = new Set();

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed. Refresh and try again.');
  return data;
}
function showError(error) { $('#run-error').textContent = error.message; $('#run-error').hidden = false; }
function rememberSelection(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('run', id); else url.searchParams.delete('run');
  history.replaceState(null, '', url);
}
async function refreshHistory() {
  const runs = await api('/api/runs');
  $('#run-history').replaceChildren();
  for (const run of runs) {
    const button = document.createElement('button');
    button.textContent = run.goal; button.title = `${run.goal} · ${run.status}`;
    button.setAttribute('aria-current', String(run.id === selected?.id));
    button.onclick = () => openRun(run.id).catch(showError);
    $('#run-history').append(button);
  }
  return runs;
}
function renderRun(run) {
  clearTimeout(poll);
  selected = run;
  $('#run-detail').hidden = false;
  $('#run-title').textContent = run.goal;
  const expired = run.status === 'planning' && new Date(run.planningExpiresAt).getTime() <= Date.now();
  const statuses = {
    draft: 'Goal saved. Ready to generate a plan.',
    planning: expired ? 'Planning was interrupted. Retry to generate a fresh plan.' : 'Your goal is saved. Generating its plan…',
    planned: 'Plan saved · Ready for review',
    blocked: 'Goal saved · Planning needs attention',
  };
  $('#run-status').textContent = statuses[run.status];
  $('#run-metadata').textContent = `Model: ${run.model} · Up to ${run.limits.maxSteps} steps · ${run.limits.maxAttemptsPerStep} attempts per step · ${run.limits.maxDurationMinutes} minute execution budget · Planning attempts ${run.planningAttempts}/${run.maxPlanningAttempts}`;
  $('#run-criteria').replaceChildren();
  for (const criterion of run.successCriteria) {
    const item = document.createElement('li'); item.textContent = criterion; $('#run-criteria').append(item);
  }
  const exhausted = run.status !== 'planned' && run.planningAttempts >= run.maxPlanningAttempts && (run.status !== 'planning' || expired);
  $('#planning-error').hidden = !run.error && !exhausted;
  $('#planning-error').textContent = [run.error?.message, exhausted ? 'Planning attempt limit reached. Create a new goal with revised criteria to try again.' : ''].filter(Boolean).join(' ');
  $('#plan-run').hidden = !run.canPlan;
  $('#plan-run').disabled = pending.has(run.id);
  $('#plan-run').textContent = run.planningAttempts ? 'Retry planning' : 'Generate plan';
  $('#plan-result').hidden = !run.plan;
  $('#plan-steps').replaceChildren();
  if (run.plan) {
    $('#plan-summary').textContent = run.plan.summary;
    for (const step of run.plan.steps) {
      const item = document.createElement('li');
      const title = document.createElement('h4'); title.textContent = step.title;
      const instruction = document.createElement('p'); instruction.textContent = step.instruction;
      const dependencies = document.createElement('p'); dependencies.className = 'goal-note';
      dependencies.textContent = `${step.id} · ${step.dependsOn.length ? `After: ${step.dependsOn.join(', ')}` : 'No dependencies'}`;
      const verification = document.createElement('p');
      const label = document.createElement('strong'); label.textContent = 'Verify: ';
      verification.append(label, document.createTextNode(step.verification));
      item.append(title, instruction, dependencies, verification); $('#plan-steps').append(item);
    }
  }
  if (run.status === 'planning' && !expired) {
    poll = setTimeout(() => reloadSelected().catch(showError), 5000);
  }
}
async function reloadSelected() {
  const id = selected?.id;
  if (!id) return;
  const run = await api(`/api/runs/${id}`);
  if (selected?.id === id) renderRun(run);
}
async function openRun(id) {
  // Set the identity immediately so a response for another run cannot replace it.
  clearTimeout(poll); selected = { id };
  rememberSelection(id);
  $('#run-error').hidden = true;
  $('#run-detail').hidden = true;
  $('#new-run').open = false;
  await reloadSelected();
  await refreshHistory();
}
async function generatePlan(id) {
  if (pending.has(id)) return;
  pending.add(id);
  if (selected?.id === id) {
    $('#plan-run').disabled = true;
    $('#run-status').textContent = 'Your goal is saved. Generating its plan…';
  }
  try {
    const run = await api(`/api/runs/${id}/plan`, {});
    if (selected?.id === id) renderRun(run);
  } catch (error) {
    if (selected?.id === id) { showError(error); await reloadSelected().catch(showError); }
  } finally {
    pending.delete(id);
    if (selected?.id === id) $('#plan-run').disabled = false;
    await refreshHistory().catch(showError);
  }
}
$('#goal-form').onsubmit = async event => {
  event.preventDefault();
  if (saving || !enabled) return;
  saving = true; $('#create-run').disabled = true; $('#run-error').hidden = true;
  try {
    const run = await api('/api/runs', {
      goal: $('#goal').value.trim(),
      successCriteria: $('#criteria').value.split('\n').map(line => line.trim()).filter(Boolean),
      limits: { maxSteps: Number($('#max-steps').value), maxAttemptsPerStep: Number($('#max-attempts').value), maxDurationMinutes: Number($('#max-minutes').value) },
    });
    rememberSelection(run.id); renderRun(run); $('#new-run').open = false;
    $('#goal-form').reset();
    await refreshHistory();
    await generatePlan(run.id);
  } catch (error) { showError(error); }
  finally { saving = false; $('#create-run').disabled = false; }
};
$('#new-goal').onclick = () => {
  if (!enabled) return;
  clearTimeout(poll); selected = null; rememberSelection(null);
  $('#run-detail').hidden = true; $('#new-run').open = true; $('#run-error').hidden = true;
  $('#goal').focus(); refreshHistory().catch(showError);
};
$('#refresh-run').onclick = () => reloadSelected().catch(showError);
$('#plan-run').onclick = () => { if (selected?.id) generatePlan(selected.id).catch(showError); };

async function init() {
  try {
    const status = await api('/api/status');
    if (status.authEnabled) {
      const me = await fetch('/api/me');
      if (me.status === 401) { $('#goals-auth').hidden = false; $('#run-mode').textContent = 'Sign in required'; return; }
      if (!me.ok) throw new Error('Could not load your account. Refresh to try again.');
    }
    if (!status.goalPlanningEnabled) throw new Error('Goal planning is not available on this server.');
    enabled = true; $('#goals-workspace').hidden = false;
    $('#run-mode').textContent = status.demo ? 'Demo · No AI connected' : 'OpenCode';
    if (status.demo) $('#storage-note').textContent = 'Demo only: sample plans, no AI, and temporary history that resets when the server stops.';
    const runs = await refreshHistory();
    const id = new URL(location.href).searchParams.get('run') || runs[0]?.id;
    if (id) await openRun(id);
  } catch (error) {
    $('#goals-unavailable').textContent = error.message; $('#goals-unavailable').hidden = false;
    $('#run-mode').textContent = 'Unavailable';
  }
}
init();
