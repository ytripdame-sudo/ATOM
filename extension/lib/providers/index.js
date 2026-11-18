/**
 * Provider registry. The agent never imports a vendor directly — it asks for a
 * provider by id, so Claude / Qwen / local Ollama can be added by dropping a
 * module in this folder and listing it below (spec §12).
 */
import { groq } from './groq.js';

export const providers = [groq];

export const DEFAULT_PROVIDER_ID = 'groq';

export function providerById(id) {
  return providers.find((p) => p.id === id) || groq;
}

/** Serialisable provider metadata for the settings UI. */
export function providerMeta() {
  return {
    defaultProvider: DEFAULT_PROVIDER_ID,
    providers: providers.map((p) => ({
      id: p.id,
      label: p.label,
      keyHint: p.keyHint,
      models: p.models.map((m) => ({ id: m.id, label: m.label, note: m.note, tag: m.tag || '' })),
    })),
  };
}
