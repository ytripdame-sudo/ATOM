/**
 * Settings are the only thing the UI and the service worker both own.
 * The API key lives here (chrome.storage.local) and is never sent to the UI —
 * the panel only learns whether a key exists.
 */

import { normalizeGrants } from './grants.js';

const STORAGE_KEY = 'atom.settings';

export const DEFAULT_SETTINGS = Object.freeze({
  provider: 'groq',
  model: 'openai/gpt-oss-120b',
  apiKey: '',
  instructions: '',
  theme: 'system',
  attachTab: true,
  autonomy: 'balanced',
  // '' means the one-time first-run question has not been answered yet.
  accessChoice: '',
  // "Don't ask again" for one action on one site. Revocable in Settings.
  actionGrants: [],
  // Facts the user chose to keep: typed in Settings, or saved by a confirmed
  // `remember`. They travel to the model as trustable, because the user
  // approved each one.
  memories: [],
  // The browsing agent. Off keeps ATOM a chat assistant; Ask runs the task but
  // confirms each action; Playground runs it autonomously within the floors.
  // Off by default: browsing is something the user turns on, not something a
  // chat assistant starts doing to their tabs.
  agent: {
    mode: 'off',
    stepLimit: 16,
    trustedSites: [],
  },
  // One list of keys per provider. More keys mean more free tokens per minute.
  keyPool: { groq: [], gemini: [], openrouter: [] },
  // Move to the next key/provider when one is out of quota.
  rotate: true,
  // The ceiling for one request, in estimated tokens. Free tiers are small.
  maxRequestTokens: 6000,
  // How much of a page a read brings back. Free tiers count every token.
  readLimit: 'normal',
  // Any OpenAI-compatible server: a hosted one, or Ollama / LM Studio locally.
  custom: { baseUrl: '', model: '', key: '' },
  // Deep think is per message; the effort is the part worth remembering.
  reasoningEffort: 'medium',
  // Web search: one provider, its own key, and a small character budget for
  // page text. Auto means the model may search when a question needs news.
  search: {
    provider: 'duckduckgo',
    key: '',
    endpoint: '',
    auto: false,
    budget: 1200,
  },
  // Voice: speaking replies and talking to ATOM. Both stay off until asked for.
  // `endpoint` is where the custom voice speaks from (Polly "Justin" is meant
  // to be reached through a signing proxy, see Settings → Voice).
  voice: {
    enabled: false,
    handsFree: false,
    provider: 'browser',
    voiceURI: '',
    rate: 1,
    volume: 1,
    endpoint: '',
    key: '',
    stt: 'auto',
  },
  // The start page's own theme: background, accent, font, layout, widgets.
  startpage: {
    background: 'aurora',
    color: '#0b0e14',
    accent: '#7aa2ff',
    image: '',
    font: 'sans',
    width: 'default',
    clock: true,
    greeting: true,
    date: true,
    links: [],
  },
});

const BACKGROUNDS = new Set(['aurora', 'midnight', 'daylight', 'nebula', 'sand', 'solid', 'image']);
const FONTS = new Set(['sans', 'serif', 'mono', 'rounded']);
const WIDTHS = new Set(['narrow', 'default', 'wide']);
const READ_LIMITS = new Set(['small', 'normal', 'large']);
const VOICE_PROVIDERS = new Set(['browser', 'http']);
const SEARCH_PROVIDERS = new Set(['duckduckgo', 'bing', 'serper', 'github', 'brave', 'searx', 'wikipedia']);
const EFFORTS = new Set(['low', 'medium', 'high']);
const STT_MODES = new Set(['auto', 'browser', 'whisper']);
const MAX_IMAGE_CHARS = 2_500_000;

const PROVIDER_IDS = ['groq', 'gemini', 'openrouter'];
const MAX_KEYS_PER_PROVIDER = 8;

const MAX_MEMORIES = 40;
const MAX_MEMORY_CHARS = 300;

const THEMES = new Set(['system', 'light', 'dark']);
const MODES = new Set(['assisted', 'balanced', 'autonomous']);
const AGENT_MODES = new Set(['off', 'ask', 'playground']);
const MAX_TRUSTED_SITES = 20;
const ACCESS_CHOICES = new Set(['allow-all', 'per-site']);

/** Coerce anything that came out of storage into a safe, known-good shape. */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const merged = { ...DEFAULT_SETTINGS, ...source };
  const keyPool = normalizeKeyPool(merged.keyPool, merged.apiKey);

  return {
    provider: text(merged.provider) || DEFAULT_SETTINGS.provider,
    model: text(merged.model) || DEFAULT_SETTINGS.model,
    // The single legacy key is the first Groq key; the pool is what is used.
    apiKey: text(merged.apiKey) || keyPool.groq[0] || '',
    // Long prompts are the point: an imported playbook or a house style can be
    // tens of thousands of characters. The cap only guards storage.
    instructions: clamp(text(merged.instructions), 200000),
    theme: THEMES.has(merged.theme) ? merged.theme : DEFAULT_SETTINGS.theme,
    attachTab: merged.attachTab !== false,
    autonomy: MODES.has(merged.autonomy) ? merged.autonomy : DEFAULT_SETTINGS.autonomy,
    accessChoice: ACCESS_CHOICES.has(merged.accessChoice) ? merged.accessChoice : '',
    actionGrants: normalizeGrants(merged.actionGrants),
    memories: normalizeMemories(merged.memories),
    agent: normalizeAgent(merged.agent),
    keyPool,
    rotate: merged.rotate !== false,
    maxRequestTokens: number(merged.maxRequestTokens, 2000, 150000, DEFAULT_SETTINGS.maxRequestTokens),
    readLimit: READ_LIMITS.has(merged.readLimit) ? merged.readLimit : DEFAULT_SETTINGS.readLimit,
    custom: normalizeCustom(merged.custom),
    reasoningEffort: EFFORTS.has(merged.reasoningEffort) ? merged.reasoningEffort : DEFAULT_SETTINGS.reasoningEffort,
    search: normalizeSearch(merged.search),
    voice: normalizeVoice(merged.voice),
    startpage: normalizeStartPage(merged.startpage),
  };
}

/**
 * An endpoint the user supplies. The key is optional on purpose: Ollama and
 * LM Studio run on this machine and want no key at all.
 */
function normalizeCustom(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const baseUrl = String(source.baseUrl || '').trim().replace(/\/+$/, '');
  const allowed = /^https?:\/\/[^\s"']+$/i.test(baseUrl) && baseUrl.length <= 300;

  return {
    baseUrl: allowed ? baseUrl : '',
    model: text(source.model).slice(0, 120),
    key: text(source.key).slice(0, 300),
  };
}

/**
 * A voice that is half-configured is worse than none: an endpoint that is not
 * an address, a rate of 40×, a volume that cannot be heard. Everything lands in
 * a known range, and the two switches stay booleans rather than truthy strings.
 */
/**
 * A search provider is picked, not typed, and each has its own idea of a key.
 * DuckDuckGo, GitHub and Wikipedia need nothing, which is why one of them is
 * the default; SearXNG needs an address and Brave needs a token.
 */
function normalizeSearch(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const defaults = DEFAULT_SETTINGS.search;
  const endpoint = String(source.endpoint || '').trim();

  return {
    provider: SEARCH_PROVIDERS.has(source.provider) ? source.provider : defaults.provider,
    key: text(source.key).slice(0, 300),
    endpoint: /^https?:\/\/[^\s"']+$/i.test(endpoint) && endpoint.length <= 300 ? endpoint.replace(/\/+$/, '') : '',
    auto: source.auto === true,
    budget: number(source.budget, 300, 6000, defaults.budget),
  };
}

/**
 * Trusted sites are written as hosts, not patterns: "github.com" covers its
 * subdomains, and nothing about this list is a wildcard the model can edit.
 */
function normalizeAgent(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const defaults = DEFAULT_SETTINGS.agent;
  const sites = [];
  const seen = new Set();

  for (const entry of Array.isArray(source.trustedSites) ? source.trustedSites : []) {
    const host = String(entry || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^www\./, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || seen.has(host)) continue;
    seen.add(host);
    sites.push(host);
    if (sites.length >= MAX_TRUSTED_SITES) break;
  }

  return {
    mode: AGENT_MODES.has(source.mode) ? source.mode : defaults.mode,
    stepLimit: number(source.stepLimit, 4, 40, defaults.stepLimit),
    trustedSites: sites,
  };
}

function normalizeVoice(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const defaults = DEFAULT_SETTINGS.voice;
  const endpoint = String(source.endpoint || '').trim();

  return {
    enabled: source.enabled === true,
    handsFree: source.handsFree === true,
    provider: VOICE_PROVIDERS.has(source.provider) ? source.provider : defaults.provider,
    // A voice URI is the browser's own identifier; it is chosen, never typed.
    voiceURI: text(source.voiceURI).slice(0, 300),
    rate: fraction(source.rate, 0.5, 2, defaults.rate),
    volume: fraction(source.volume, 0, 1, defaults.volume),
    endpoint:
      /^https?:\/\/[^\s"']+$/i.test(endpoint) && endpoint.length <= 300 ? endpoint : '',
    key: text(source.key).slice(0, 300),
    stt: STT_MODES.has(source.stt) ? source.stt : defaults.stt,
  };
}

function normalizeStartPage(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const defaults = DEFAULT_SETTINGS.startpage;

  return {
    background: BACKGROUNDS.has(source.background) ? source.background : defaults.background,
    color: hex(source.color) || defaults.color,
    accent: hex(source.accent) || defaults.accent,
    image: backgroundImage(source.image),
    font: FONTS.has(source.font) ? source.font : defaults.font,
    width: WIDTHS.has(source.width) ? source.width : defaults.width,
    clock: source.clock !== false,
    greeting: source.greeting !== false,
    date: source.date !== false,
    links: normalizeLinks(source.links),
  };
}

function hex(value) {
  const candidate = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate.toLowerCase() : '';
}

/** A picture is either an https address or an uploaded data URL, capped. */
function backgroundImage(value) {
  const candidate = String(value || '').trim();
  if (candidate.length > MAX_IMAGE_CHARS) return '';
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(candidate)) return candidate;
  if (/^https:\/\/[^\s"']+$/i.test(candidate) && candidate.length <= 2000) return candidate;
  return '';
}

function normalizeLinks(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const links = [];

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const url = String(entry.url || '').trim();
    if (!/^https?:\/\/[^\s"']+$/i.test(url)) continue;
    const title = text(entry.title).slice(0, 40) || new URL(url).hostname.replace(/^www\./, '');
    links.push({ title, url });
    if (links.length >= 12) break;
  }

  return links;
}

export async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeSettings(stored?.[STORAGE_KEY]);
  } catch {
    return normalizeSettings(null);
  }
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = normalizeSettings({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** The slice of settings the UI is allowed to see. Never includes the key. */
export function publicSettings(settings) {
  return {
    provider: settings.provider,
    model: settings.model,
    instructions: settings.instructions,
    theme: settings.theme,
    attachTab: settings.attachTab,
    autonomy: settings.autonomy,
    accessChoice: settings.accessChoice,
    actionGrants: settings.actionGrants,
    memories: settings.memories,
    agent: settings.agent,
    // Counts, never the keys themselves.
    keyCounts: Object.fromEntries(PROVIDER_IDS.map((id) => [id, settings.keyPool?.[id]?.length || 0])),
    // The chosen provider has to have a key of its own, or the next turn cannot
    // start; other providers' keys only matter when rotation reaches them.
    hasKey:
      settings.provider === 'custom'
        ? Boolean(settings.custom?.baseUrl)
        : (settings.keyPool?.[settings.provider]?.length || 0) > 0,
    hasKeys: PROVIDER_IDS.some((id) => (settings.keyPool?.[id]?.length || 0) > 0) || Boolean(settings.custom?.baseUrl),
    rotate: settings.rotate,
    maxRequestTokens: settings.maxRequestTokens,
    readLimit: settings.readLimit,
    // The endpoint is public; the key is not.
    custom: {
      baseUrl: settings.custom?.baseUrl || '',
      model: settings.custom?.model || '',
      hasKey: Boolean(settings.custom?.key),
    },
    startpage: settings.startpage,
    reasoningEffort: settings.reasoningEffort || 'medium',
    // The search key is never sent to the panel; whether one exists is enough.
    search: {
      provider: settings.search?.provider || 'duckduckgo',
      auto: settings.search?.auto === true,
      budget: settings.search?.budget ?? 1200,
      endpoint: settings.search?.endpoint || '',
      hasKey: Boolean(settings.search?.key),
    },
    // The voice settings are all safe to show — except the custom voice's key,
    // which is reported as a boolean like the endpoint's.
    voice: {
      enabled: settings.voice?.enabled === true,
      handsFree: settings.voice?.handsFree === true,
      provider: settings.voice?.provider || 'browser',
      voiceURI: settings.voice?.voiceURI || '',
      rate: settings.voice?.rate ?? 1,
      volume: settings.voice?.volume ?? 1,
      endpoint: settings.voice?.endpoint || '',
      stt: settings.voice?.stt || 'auto',
      hasKey: Boolean(settings.voice?.key),
    },
  };
}

function normalizeKeyPool(raw, apiKey) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const pool = {};

  for (const id of PROVIDER_IDS) {
    const list = Array.isArray(source[id]) ? source[id] : [];
    pool[id] = [...new Set(list.map(text).filter(Boolean))].slice(0, MAX_KEYS_PER_PROVIDER);
  }

  // A key saved before the pool existed is still a Groq key.
  const primary = text(apiKey);
  if (primary && !pool.groq.includes(primary)) pool.groq = [primary, ...pool.groq].slice(0, MAX_KEYS_PER_PROVIDER);

  return pool;
}

function number(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** The same, without rounding: speed and volume are continuous. */
function fraction(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed * 100) / 100));
}

export function addMemory(memories, value) {
  const clean = normalizeMemories(memories);
  const entry = clamp(textValue(value), MAX_MEMORY_CHARS);
  if (!entry) return clean;
  if (clean.some((memory) => memory.text.toLowerCase() === entry.toLowerCase())) return clean;
  return normalizeMemories([
    ...clean,
    { id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, text: entry, at: Date.now() },
  ]);
}

export function removeMemory(memories, id) {
  return normalizeMemories(memories).filter((memory) => memory.id !== id);
}

function normalizeMemories(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const memories = [];

  for (const entry of raw) {
    const text = clamp(textValue(entry?.text), MAX_MEMORY_CHARS);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    memories.push({
      id: typeof entry?.id === 'string' && entry.id ? entry.id : `m_${memories.length}_${Date.now().toString(36)}`,
      text,
      at: Number(entry?.at) || 0,
    });
    if (memories.length >= MAX_MEMORIES) break;
  }

  return memories;
}

function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clamp(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}
