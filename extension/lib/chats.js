/**
 * Conversations are a shelf of sessions, one of them open.
 *
 * The worker owns the whole shelf; the panel only ever names a chat by id. Each
 * chat is exactly the object session.js already knows how to normalise, so a
 * conversation that predates this feature survives as the first one.
 */

import { newSession, normalizeChat, createMessage } from './session.js';

const STORAGE_KEY = 'atom.chats';
/** The single-session key from before conversations existed. Erase removes it. */
export const LEGACY_KEY = 'atom.session';

/**
 * Enough for a real history, still one storage write. A chat's own messages are
 * capped in session.js, so this is not unbounded growth.
 */
export const MAX_CHATS = 60;

export function emptyStore() {
  const chat = newSession();
  return { activeId: chat.id, chats: [chat] };
}

export async function loadChats() {
  let stored = null;
  try {
    stored = await chrome.storage.local.get([STORAGE_KEY, LEGACY_KEY]);
  } catch {
    stored = null;
  }

  const existing = normalizeStore(stored?.[STORAGE_KEY]);
  if (existing) return existing;

  // The single session from before conversations existed becomes chat one.
  const legacy = normalizeChat(stored?.[LEGACY_KEY]);
  if (legacy) return { activeId: legacy.id, chats: [legacy] };

  return emptyStore();
}

export async function saveChats(store) {
  const safe = normalizeStore(store);
  if (!safe) return;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: safe });
  } catch {
    /* Storage pressure: the in-memory shelf is still authoritative. */
  }
}

export function normalizeStore(raw) {
  if (!raw || !Array.isArray(raw.chats)) return null;

  const chats = raw.chats
    .map(normalizeChat)
    .filter(Boolean)
    .slice(-MAX_CHATS);
  if (!chats.length) return null;

  const activeId = chats.some((chat) => chat.id === raw.activeId) ? raw.activeId : chats[chats.length - 1].id;
  return { activeId, chats };
}

export function chatById(store, id) {
  return store?.chats?.find((chat) => chat.id === id) || null;
}

/**
 * A new conversation goes to the front of the shelf and becomes the open one.
 * The oldest conversation that is not open is dropped once the shelf is full.
 */
export function addChat(store) {
  const chat = newSession();
  const chats = [chat, ...(store?.chats || [])];

  while (chats.length > MAX_CHATS) {
    const victim = chats.map((entry, index) => ({ entry, index })).reverse().find(({ entry }) => entry.id !== chat.id);
    if (!victim) break;
    chats.splice(victim.index, 1);
  }

  return { store: { activeId: chat.id, chats }, chat };
}

/**
 * Removing the open conversation opens the most recent one instead. The shelf
 * is never left empty: deleting the last chat clears it rather than leaving the
 * panel with nothing to show.
 */
export function removeChat(store, id) {
  const chats = (store?.chats || []).filter((chat) => chat.id !== id);
  if (!chats.length) return emptyStore();
  if (store?.activeId === id) {
    const next = [...chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    return { activeId: next.id, chats };
  }
  return { activeId: store.activeId, chats };
}

/** What the panel's conversation list needs: pinned first, then newest. */
export function chatSummaries(store) {
  return (store?.chats || [])
    .map((chat) => ({
      id: chat.id,
      title: chat.title || '',
      pinned: chat.pinned === true,
      updatedAt: chat.updatedAt || 0,
      messages: chat.messages?.length || 0,
    }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

export function renameChat(store, id, title) {
  const chat = chatById(store, id);
  if (!chat) return false;
  const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!clean) return false;
  chat.title = clean;
  return true;
}

export function pinChat(store, id, pinned) {
  const chat = chatById(store, id);
  if (!chat) return false;
  chat.pinned = pinned === true;
  return true;
}

/**
 * A search reads the transcript, not just the title: "that thing about the
 * regex" is how people remember a conversation. One line of context is enough
 * to recognise it; the whole message is not.
 */
export function searchChats(store, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return chatSummaries(store);

  const found = [];
  for (const chat of store?.chats || []) {
    const title = String(chat.title || '');
    let snippet = '';
    const inTitle = title.toLowerCase().includes(needle);
    if (!inTitle) {
      for (const message of chat.messages || []) {
        const text = String(message.text || '');
        const at = text.toLowerCase().indexOf(needle);
        if (at === -1) continue;
        snippet = `${at > 24 ? '…' : ''}${text.slice(Math.max(0, at - 24), at + needle.length + 40).replace(/\s+/g, ' ')}…`;
        break;
      }
    }
    if (!inTitle && !snippet) continue;
    found.push({
      id: chat.id,
      title: title || 'New conversation',
      pinned: chat.pinned === true,
      updatedAt: chat.updatedAt || 0,
      messages: chat.messages?.length || 0,
      snippet,
    });
  }

  return found.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

/** A chat as a file: the messages and a title, nothing about this browser. */
export function exportChat(store, id) {
  const chat = chatById(store, id);
  if (!chat) return '';
  return JSON.stringify(
    {
      atom: 'chat',
      version: 1,
      title: chat.title || '',
      exportedAt: new Date().toISOString(),
      messages: (chat.messages || []).map((message) => ({
        role: message.role,
        text: message.text || '',
        ts: message.ts || 0,
      })),
    },
    null,
    2,
  );
}

/**
 * An imported chat is new: fresh ids, so importing the same file twice makes
 * two conversations instead of one with duplicated message ids.
 */
export function importChat(store, json) {
  let raw;
  try {
    raw = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return { error: 'That file is not JSON.' };
  }

  if (!raw || !Array.isArray(raw.messages)) return { error: 'That file has no messages in it.' };

  const messages = raw.messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .filter((message) => typeof message.text === 'string' && message.text.trim())
    .map((message) => createMessage(message.role, message.text, { ts: Number(message.ts) || Date.now() }));

  if (!messages.length) return { error: 'That file has no messages in it.' };

  const chat = normalizeChat({
    title: String(raw.title || '').slice(0, 120),
    messages,
    createdAt: Number(messages[0]?.ts) || Date.now(),
    updatedAt: Date.now(),
  });
  if (!chat) return { error: 'That file could not be read as a conversation.' };

  const chats = [chat, ...(store?.chats || [])].slice(0, MAX_CHATS);
  return { store: { activeId: chat.id, chats } };
}

/**
 * The history groups people expect: what is pinned, then today, yesterday, the
 * week, the month, and everything older. Computed here so the panel only draws.
 */
export function groupChats(summaries, now = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();

  const groups = new Map();
  const add = (label, chat) => {
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(chat);
  };

  for (const chat of summaries || []) {
    if (chat.pinned) add('Pinned', chat);
    else if (chat.updatedAt >= today) add('Today', chat);
    else if (chat.updatedAt >= today - day) add('Yesterday', chat);
    else if (chat.updatedAt >= today - 7 * day) add('Previous 7 days', chat);
    else if (chat.updatedAt >= today - 30 * day) add('Previous 30 days', chat);
    else add('Earlier', chat);
  }

  return [...groups.entries()].map(([label, items]) => ({ label, items }));
}
