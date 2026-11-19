/**
 * Provider registry. The agent never imports a vendor directly — it asks for a
 * provider by id, so another vendor is a module in this folder plus a line here,
 * and any OpenAI-compatible endpoint the user names is resolved on demand.
 */
import { groq } from './groq.js';
import { gemini } from './gemini.js';
import { openrouter } from './openrouter.js';
import { createOpenAIProvider } from './openai.js';

export const providers = [groq, gemini, openrouter];

export const DEFAULT_PROVIDER_ID = 'groq';

/**
 * The endpoint from Settings: a hosted OpenAI-compatible server, or Ollama and
 * LM Studio on this machine. It needs no key, so `needsKey` is false and the
 * pool will call it with an empty one.
 */
export function customProvider(custom) {
  const baseUrl = String(custom?.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) return null;

  const model = String(custom.model || '').trim() || 'local-model';

  return createOpenAIProvider({
    id: 'custom',
    label: labelFor(baseUrl),
    keyHint: 'optional for a local server',
    chatEndpoint: `${baseUrl}/chat/completions`,
    modelsEndpoint: `${baseUrl}/models`,
    models: [{ id: model, label: model, note: 'your endpoint', tag: 'default' }],
    needsKey: false,
  });
}

/** Every provider that could answer with these settings. */
export function resolveProviders(settings) {
  const custom = customProvider(settings?.custom);
  return custom ? [...providers, custom] : providers;
}

export function providerById(id, settings) {
  const list = resolveProviders(settings);
  return list.find((provider) => provider.id === id) || list[0];
}

/** The model a provider uses when it was not the one the user picked. */
export function defaultModelFor(provider) {
  return provider.models.find((model) => model.tag === 'default')?.id || provider.models[0].id;
}

/**
 * Whether the selected model accepts image parts. Only models whose vendor
 * documents image input are marked, so a custom endpoint stays text-only until
 * its model is added to a provider with a `vision: true` entry.
 */
export function modelVision(settings) {
  const provider = providerById(settings?.provider, settings);
  return modelSupportsVision(provider, settings?.model);
}

/** A provider/model pair, for the rotation pool deciding what can take a picture. */
export function modelSupportsVision(provider, modelId) {
  return provider?.models?.find((entry) => entry.id === modelId)?.vision === true;
}

/** Serialisable provider metadata for the settings UI. */
export function providerMeta(settings) {
  return {
    defaultProvider: DEFAULT_PROVIDER_ID,
    providers: resolveProviders(settings).map((provider) => ({
      id: provider.id,
      label: provider.label,
      keyHint: provider.keyHint,
      needsKey: provider.needsKey !== false,
      models: provider.models.map((model) => ({
        id: model.id,
        label: model.label,
        note: model.note,
        tag: model.tag || '',
        // Whether the composer can offer low/medium/high for this model.
        reasoning: model.reasoning === true,
        // Whether a screenshot can be sent to it as an image part.
        vision: model.vision === true,
      })),
    })),
  };
}

function labelFor(baseUrl) {
  try {
    const url = new URL(baseUrl);
    const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(url.hostname);
    return local ? `Local (${url.host})` : `Custom (${url.host})`;
  } catch {
    return 'Custom endpoint';
  }
}
