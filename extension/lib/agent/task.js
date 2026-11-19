/**
 * The browsing task the side panel watches: a short plan, the step being worked
 * on, and a log of what actually happened.
 *
 * Pure and worker-agnostic. The worker owns the object; the panel only ever
 * receives `taskSnapshot`, so pausing and resuming cannot depend on UI state.
 */

export const AGENT_MODES = ['off', 'ask', 'playground'];

export const AGENT_MODE_HINTS = {
  off: 'Chat and look things up. No browsing runs on its own.',
  ask: 'ATOM works the task, but every action waits for your yes.',
  playground: 'ATOM works the task on its own. Payments, sending, deleting and passwords still ask.',
};

const MAX_PLAN = 8;
const MAX_STEP_CHARS = 140;
const MAX_LOG = 40;
const MAX_LOG_CHARS = 220;

export function createTask(text) {
  return {
    id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    text: String(text || '').slice(0, 300),
    phase: 'running',
    plan: [],
    step: 0,
    log: [],
    startedAt: Date.now(),
  };
}

/** What the panel gets. No closures, no DOM, no accidental data URLs. */
export function taskSnapshot(task) {
  if (!task) return null;
  return {
    id: task.id,
    text: task.text,
    phase: task.phase,
    plan: task.plan.slice(0, MAX_PLAN),
    step: task.step,
    log: task.log.slice(-14).map((entry) => ({
      id: entry.id,
      text: entry.text,
      status: entry.status,
      at: entry.at,
    })),
    startedAt: task.startedAt,
  };
}

export function setPlan(task, steps) {
  if (!task) return [];
  const plan = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    const text = String(step || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    plan.push(text.slice(0, MAX_STEP_CHARS));
    if (plan.length >= MAX_PLAN) break;
  }
  task.plan = plan;
  return plan;
}

export function addLog(task, text, status = 'running') {
  if (!task) return null;
  const entry = {
    id: `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    text: String(text || '').slice(0, MAX_LOG_CHARS),
    status,
    at: Date.now(),
  };
  task.log.push(entry);
  if (task.log.length > MAX_LOG) task.log.splice(0, task.log.length - MAX_LOG);
  return entry;
}

export function updateLog(task, id, patch) {
  const entry = task?.log.find((item) => item.id === id);
  if (!entry) return null;
  Object.assign(entry, patch || {});
  return entry;
}

/** Pause is honoured between steps and between calls, never mid-click. */
export function setPhase(task, phase) {
  if (!task) return;
  if (!['running', 'paused', 'stopped', 'done'].includes(phase)) return;
  task.phase = phase;
}

export function trustHost(trustedSites, url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  return (Array.isArray(trustedSites) ? trustedSites : []).some((entry) => {
    const site = String(entry || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^www\./, '');
    return Boolean(site) && (host === site || host.endsWith(`.${site}`));
  });
}

const IRREVERSIBLE =
  /\b(pay|payment|buy|purchase|order|checkout|place order|send|submit|delete|remove|erase|unsubscribe|install|uninstall|transfer|donate|book now|reserve|cancel (my|the|subscription)|confirm)\b/i;

/**
 * The text a click will affect, plus the tool's own arguments. A "Delete"
 * button is irreversible even in Playground, wherever it lives. Adding a song
 * to a playlist is not: "add" is deliberately absent from the pattern.
 */
export function looksIrreversible({ tool = '', args = {}, refMeta = null } = {}) {
  if (tool === 'run_js' || tool === 'download') return true;
  const label = [refMeta?.name, refMeta?.placeholder, args?.text].filter(Boolean).join(' ');
  if (!label) return false;
  return IRREVERSIBLE.test(label);
}
