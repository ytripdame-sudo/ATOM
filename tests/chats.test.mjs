import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CHATS,
  addChat,
  chatById,
  chatSummaries,
  exportChat,
  groupChats,
  importChat,
  pinChat,
  renameChat,
  searchChats,
  emptyStore,
  loadChats,
  normalizeStore,
  removeChat,
  saveChats,
} from '../extension/lib/chats.js';

const message = (id, text) => ({ id, role: 'user', text, ts: 1, status: 'done' });

function withStorage(initial) {
  const store = { ...initial };
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((key) => key in store).map((key) => [key, store[key]]));
        },
        async set(values) {
          Object.assign(store, values);
        },
      },
    },
  };
  return store;
}

test('a single old session becomes the first conversation', async () => {
  const store = withStorage({
    'atom.session': { id: 's1', title: 'Old chat', messages: [message('m1', 'hi')], createdAt: 1, updatedAt: 2 },
  });

  const shelf = await loadChats();
  assert.equal(shelf.chats.length, 1);
  assert.equal(shelf.activeId, 's1');
  assert.equal(shelf.chats[0].title, 'Old chat');
  assert.equal(shelf.chats[0].messages.length, 1);

  await saveChats(shelf);
  assert.equal(store['atom.chats'].activeId, 's1');
});

test('a new conversation goes to the front and becomes the open one', () => {
  const first = emptyStore();
  const { store, chat } = addChat(first);

  assert.equal(store.chats.length, 2);
  assert.equal(store.activeId, chat.id);
  assert.equal(store.chats[0].id, chat.id);
  assert.equal(chat.messages.length, 0);
});

test('the shelf is capped, never emptied, and never left without an open chat', () => {
  let store = emptyStore();
  for (let index = 0; index < MAX_CHATS + 3; index += 1) store = addChat(store).store;
  assert.equal(store.chats.length, MAX_CHATS);

  const open = store.activeId;
  const other = store.chats.find((chat) => chat.id !== open);
  const afterDelete = removeChat(store, open);
  assert.equal(afterDelete.chats.length, MAX_CHATS - 1);
  assert.notEqual(afterDelete.activeId, open, 'another conversation opens instead');

  const single = emptyStore();
  const emptied = removeChat(single, single.activeId);
  assert.equal(emptied.chats.length, 1, 'the shelf is never empty');
  assert.notEqual(emptied.chats[0].id, single.chats[0].id, 'a fresh conversation replaces it');
  assert.ok(other);
});

test('the panel gets titles, counts and a newest-first order', () => {
  const store = normalizeStore({
    activeId: 'b',
    chats: [
      { id: 'a', title: 'Alpha', messages: [message('m1', 'x')], updatedAt: 10 },
      { id: 'b', title: '', messages: [], updatedAt: 30 },
    ],
  });

  assert.deepEqual(chatSummaries(store).map((chat) => chat.id), ['b', 'a']);
  assert.equal(chatSummaries(store)[1].messages, 1);
  assert.equal(chatById(store, 'a').title, 'Alpha');
  assert.equal(chatById(store, 'nope'), null);
});

test('a stored shelf with junk keeps only what is usable', () => {
  const store = normalizeStore({
    activeId: 'missing',
    chats: [{ id: 'ok', messages: [], title: 'Fine' }, { nope: true }, null],
  });

  assert.equal(store.chats.length, 1);
  assert.equal(store.activeId, 'ok', 'a dangling active id falls back to a real chat');
  assert.equal(normalizeStore({}), null);
  assert.equal(normalizeStore(null), null);
});

test('rename and pin change what the history shows, and pinning sorts first', () => {
  const store = normalizeStore({
    activeId: 'a',
    chats: [
      { id: 'a', title: 'Alpha', messages: [message('m1', 'x')], updatedAt: 30 },
      { id: 'b', title: '', messages: [], updatedAt: 10 },
    ],
  });

  assert.equal(renameChat(store, 'a', '  A better   name '), true);
  assert.equal(chatById(store, 'a').title, 'A better name');
  assert.equal(renameChat(store, 'a', '   '), false, 'an empty name is refused');

  assert.equal(pinChat(store, 'b', true), true);
  assert.deepEqual(chatSummaries(store).map((chat) => chat.id), ['b', 'a'], 'pinned outranks newer');
  assert.equal(chatSummaries(store)[0].pinned, true);
});

test('a search reads the transcript, not just the title', () => {
  const store = normalizeStore({
    activeId: 'a',
    chats: [
      { id: 'a', title: 'Alpha', messages: [message('m1', 'the regex was wrong')], updatedAt: 30 },
      { id: 'b', title: 'Regex notes', messages: [], updatedAt: 20 },
      { id: 'c', title: 'Nothing', messages: [message('m3', 'a shopping list')], updatedAt: 10 },
    ],
  });

  const found = searchChats(store, 'regex');
  assert.deepEqual(found.map((chat) => chat.id), ['a', 'b']);
  assert.match(found.find((chat) => chat.id === 'a').snippet, /regex was wrong/);
  assert.deepEqual(searchChats(store, 'shopping').map((chat) => chat.id), ['c']);
  assert.equal(searchChats(store, 'absent').length, 0);
  assert.equal(searchChats(store, '   ').length, 3, 'an empty query is the whole history');
});

test('a chat round-trips through JSON as a new conversation', () => {
  const store = normalizeStore({
    activeId: 'a',
    chats: [{ id: 'a', title: 'Alpha', messages: [message('m1', 'hello')], updatedAt: 30 }],
  });

  const json = exportChat(store, 'a');
  const file = JSON.parse(json);
  assert.equal(file.atom, 'chat');
  assert.equal(file.title, 'Alpha');
  assert.equal(file.messages.length, 1);
  assert.equal(exportChat(store, 'missing'), '');

  const imported = importChat(store, json);
  assert.ok(imported.store);
  assert.equal(imported.store.chats.length, 2);
  assert.notEqual(imported.store.activeId, 'a', 'the import opens as a separate chat');
  assert.equal(imported.store.chats[0].messages[0].text, 'hello');
  assert.notEqual(imported.store.chats[0].messages[0].id, 'm1', 'message ids are fresh');

  assert.equal(importChat(store, 'not json').error, 'That file is not JSON.');
  assert.equal(importChat(store, '{"messages":[]}').error, 'That file has no messages in it.');
});

test('history groups by recency, with pinned separate', () => {
  const now = new Date('2026-03-10T12:00:00Z').getTime();
  const day = 24 * 60 * 60 * 1000;
  const summaries = [
    { id: 'p', pinned: true, updatedAt: now - 40 * day },
    { id: 't', pinned: false, updatedAt: now - 60 * 1000 },
    { id: 'y', pinned: false, updatedAt: now - day },
    { id: 'w', pinned: false, updatedAt: now - 4 * day },
    { id: 'm', pinned: false, updatedAt: now - 20 * day },
    { id: 'o', pinned: false, updatedAt: now - 200 * day },
  ];

  const groups = groupChats(summaries, now);
  assert.deepEqual(
    groups.map((group) => [group.label, group.items.map((chat) => chat.id)]),
    [
      ['Pinned', ['p']],
      ['Today', ['t']],
      ['Yesterday', ['y']],
      ['Previous 7 days', ['w']],
      ['Previous 30 days', ['m']],
      ['Earlier', ['o']],
    ],
  );
});
