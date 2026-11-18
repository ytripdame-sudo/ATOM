/**
 * Settings are the only thing the UI and the service worker both own.
 * The API key lives here (chrome.storage.local) and is never sent to the UI —
 * the panel only learns whether a key exists.
 */

const STORAGE_KEY = 'atom.settings';

export const DEFAULT_SETTINGS = Object.freeze({
  provider: 'groq',
  model: 'openai/gpt-oss-120b',
  apiKey: '',
  instructions: '',
  theme: 'system',
  attachTab: true,
  autonomy: 'balanced',
});

const THEMES = new Set(['system', 'light', 'dark']);
const MODES = new Set(['assisted', 'balanced', 'autonomous']);

/** Coerce anything that came out of storage into a safe, known-good shape. */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const merged = { ...DEFAULT_SETTINGS, ...source };

  return {
    provider: text(merged.provider) || DEFAULT_SETTINGS.provider,
    model: text(merged.model) || DEFAULT_SETTINGS.model,
    apiKey: text(merged.apiKey),
    instructions: clamp(text(merged.instructions), 6000),
    theme: THEMES.has(merged.theme) ? merged.theme : DEFAULT_SETTINGS.theme,
    attachTab: merged.attachTab !== false,
    autonomy: MODES.has(merged.autonomy) ? merged.autonomy : DEFAULT_SETTINGS.autonomy,
  };
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
    hasKey: Boolean(settings.apiKey),
    instructions: settings.instructions,
    theme: settings.theme,
    attachTab: settings.attachTab,
    autonomy: settings.autonomy,
  };
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clamp(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}
