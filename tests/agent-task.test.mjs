import test from 'node:test';
import assert from 'node:assert/strict';

import { needsConfirmation } from '../extension/lib/agent/policy.js';
import {
  addLog,
  createTask,
  looksIrreversible,
  setPlan,
  taskSnapshot,
  trustHost,
  updateLog,
} from '../extension/lib/agent/task.js';

test('a task starts running with no plan and a small, serializable snapshot', () => {
  const task = createTask('Add this song to my playlist');
  const snap = taskSnapshot(task);

  assert.equal(snap.phase, 'running');
  assert.deepEqual(snap.plan, []);
  assert.equal(snap.step, 0);
  assert.match(snap.text, /playlist/);
  assert.equal(taskSnapshot(null), null);
});

test('a plan is trimmed, empty steps dropped and capped at eight', () => {
  const task = createTask('x');
  const plan = setPlan(task, ['  open  the page ', '', ...Array.from({ length: 9 }, (_, i) => `step ${i + 1}`)]);

  assert.equal(plan.length, 8);
  assert.equal(plan[0], 'open the page');
  assert.deepEqual(taskSnapshot(task).plan, plan);
});

test('the action log keeps the newest entries and can be updated by id', () => {
  const task = createTask('x');
  for (let i = 0; i < 45; i += 1) addLog(task, `action ${i}`);
  assert.equal(task.log.length, 40);
  assert.equal(taskSnapshot(task).log.at(-1).text, 'action 44');

  const entry = addLog(task, 'Click “Add”');
  updateLog(task, entry.id, { status: 'done' });
  assert.equal(taskSnapshot(task).log.at(-1).status, 'done');
});

test('a trusted host covers its subdomains, and only those', () => {
  assert.equal(trustHost(['github.com'], 'https://github.com/facebook/react'), true);
  assert.equal(trustHost(['github.com'], 'https://gist.github.com/x'), true);
  assert.equal(trustHost(['github.com'], 'https://github.com.evil.test/'), false);
  assert.equal(trustHost(['https://www.music.youtube.com/feed'], 'https://music.youtube.com/watch'), true);
  assert.equal(trustHost([], 'https://github.com'), false);
});

test('irreversible labels are recognised, and adding to a playlist is not', () => {
  assert.equal(looksIrreversible({ tool: 'click', refMeta: { name: 'Delete playlist' } }), true);
  assert.equal(looksIrreversible({ tool: 'click', refMeta: { name: 'Place order' } }), true);
  assert.equal(looksIrreversible({ tool: 'click', refMeta: { name: 'Send' } }), true);
  assert.equal(looksIrreversible({ tool: 'click', refMeta: { name: 'Add to playlist' } }), false);
  assert.equal(looksIrreversible({ tool: 'click', refMeta: { name: 'Play' } }), false);
  assert.equal(looksIrreversible({ tool: 'run_js' }), true);
  assert.equal(looksIrreversible({ tool: 'download' }), true);
});

test('ask mode stops at every mutation and leaves reading alone', () => {
  for (const tool of ['click', 'type_text', 'select_option', 'press_key', 'tabs', 'run_js']) {
    assert.equal(
      needsConfirmation({ mode: 'autonomous', agentMode: 'ask', tool, refMeta: { kind: 'button' } }),
      true,
      tool,
    );
  }
  assert.equal(needsConfirmation({ mode: 'autonomous', agentMode: 'ask', tool: 'read_page' }), false);
  assert.equal(needsConfirmation({ mode: 'autonomous', agentMode: 'ask', tool: 'plan' }), false);
});

test('playground runs ordinary actions and still stops for irreversible ones', () => {
  assert.equal(
    needsConfirmation({ mode: 'balanced', agentMode: 'playground', tool: 'click', refMeta: { kind: 'button', name: 'Add to playlist' } }),
    false,
  );
  assert.equal(
    needsConfirmation({ mode: 'balanced', agentMode: 'playground', tool: 'click', refMeta: { kind: 'button', name: 'Delete' } }),
    true,
  );
  assert.equal(needsConfirmation({ mode: 'balanced', agentMode: 'playground', tool: 'tabs', args: { action: 'close' } }), false);
  assert.equal(needsConfirmation({ mode: 'balanced', agentMode: 'playground', tool: 'run_js' }), true);
});

test('a trusted site skips ordinary prompts but never the secret floor', () => {
  assert.equal(
    needsConfirmation({ mode: 'assisted', agentMode: 'ask', trusted: true, tool: 'click', refMeta: { kind: 'button' } }),
    false,
  );
  assert.equal(
    needsConfirmation({
      mode: 'autonomous',
      agentMode: 'playground',
      trusted: true,
      tool: 'type_text',
      refMeta: { kind: 'input', sensitive: 'password' },
    }),
    true,
  );
  assert.equal(
    needsConfirmation({ mode: 'autonomous', tool: 'type_text', trusted: true, args: { submit: true } }),
    true,
  );
});
