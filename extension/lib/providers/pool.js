/**
 * The rotation pool: several providers, several keys each, tried in order.
 *
 * Free tiers limit tokens per minute per key, so the honest way to stretch them
 * is to keep more than one key warm and move on when one is out. The pool only
 * rotates on failures that another key or provider could plausibly fix — a bad
 * key, a quota, a rate limit, a model that no longer exists — and it never
 * swallows anything else.
 *
 * A provider that just failed is cooled down rather than dropped: the next turn
 * tries it again, and a successful call clears the cooldown immediately.
 */

import { ProviderError, isRetryable } from './openai.js';
import { defaultModelFor, modelSupportsVision } from './index.js';

const MINUTE = 60_000;

function cooldownFor(error) {
  switch (error?.code) {
    case 'rate_limit':
      return Math.max(30_000, Number(error?.retryAfterMs) || 0);
    case 'quota':
      return 10 * MINUTE;
    case 'auth':
      return 30 * MINUTE;
    case 'model_missing':
      return 10 * MINUTE;
    // Too large is about our request, not their limit: do not punish the key.
    case 'too_large':
      return 0;
    default:
      return MINUTE;
  }
}

/**
 * Every (provider, key, model) that could answer, preferred first. The
 * preferred provider keeps the model the user chose; the others use their own
 * default, because model ids do not travel between vendors.
 */
export function rotationCandidates({ settings, providers }) {
  const pool = settings?.keyPool || {};
  const preferred = providers.find((provider) => provider.id === settings?.provider) || providers[0];
  const ordered = [preferred, ...providers.filter((provider) => provider.id !== preferred.id)];
  const candidates = [];

  for (const provider of ordered) {
    const keys = (pool[provider.id] || []).filter(Boolean);
    // A local endpoint has no key to list, and still deserves its turn.
    if (!keys.length && provider.needsKey === false) keys.push('');
    const chosen =
      provider.id === preferred.id && provider.models.some((model) => model.id === settings?.model)
        ? settings.model
        : defaultModelFor(provider);

    keys.forEach((key, index) => {
      candidates.push({
        provider,
        key,
        model: chosen,
        slot: `${provider.id}#${index}`,
        label: keys.length > 1 ? `${provider.label} (key ${index + 1})` : provider.label,
      });
    });
  }

  return candidates;
}

// A key that just answered rests for a minute, so the next turn starts on the
// next key. That is what makes a list of free keys last longer than one key: the
// load spreads over the whole minute instead of piling onto the first key.
const SPENT_COOLDOWN_MS = 60_000;

/** Whether any message asks the provider to look at a picture. */
function hasImages(messages) {
  return messages.some(
    (message) =>
      Array.isArray(message?.content) && message.content.some((part) => part?.type === 'image_url'),
  );
}

export function createProviderPool({ settings, providers, cooldowns = new Map(), now = () => Date.now(), onSwitch, onKey }) {
  const candidates = rotationCandidates({ settings, providers });
  const warm = candidates.filter((candidate) => (cooldowns.get(candidate.slot) || 0) <= now());
  // Rotation off means exactly one attempt: the first key of the chosen
  // provider. Turning it on is what makes the other keys reachable.
  let usable = settings?.rotate === false ? candidates.slice(0, 1) : warm.length ? warm : candidates;
  let cursor = 0;

  const provider = {
    id: 'pool',
    label: 'Rotation',
    models: [],

    async streamChat(args) {
      if (!candidates.length) {
        throw new ProviderError('No API key is saved. Add one for Groq, Gemini or OpenRouter in Settings.', {
          code: 'auth',
        });
      }

      // A text-only fallback must never receive image parts: the provider would
      // reject the whole request, losing the answer along with the picture.
      // Restrict this attempt to models that can actually see the screenshot.
      const attempt = hasImages(args.messages)
        ? usable.filter((candidate) => modelSupportsVision(candidate.provider, candidate.model))
        : usable;
      if (!attempt.length) {
        throw new ProviderError(
          'This request has a screenshot, but no available key uses a model that can see images. Add a Groq or Gemini key, or choose a vision model in Settings.',
          { code: 'vision' },
        );
      }

      let last = null;
      for (let step = 0; step < attempt.length; step += 1) {
        const candidate = attempt[(cursor + step) % attempt.length];
        let emitted = false;
        onKey?.({ slot: candidate.slot, state: 'busy' });
        try {
          const result = await candidate.provider.streamChat({
            ...args,
            apiKey: candidate.key,
            model: candidate.model,
            onDelta: (chunk) => {
              emitted = true;
              args.onDelta?.(chunk);
            },
            onReasoning: (chunk) => {
              emitted = true;
              args.onReasoning?.(chunk);
            },
          });
          if (step > 0) onSwitch?.({ from: attempt[cursor % attempt.length], to: candidate, error: last });
          cursor = (cursor + step) % attempt.length;
          const until = now() + SPENT_COOLDOWN_MS;
          cooldowns.set(candidate.slot, until);
          onKey?.({ slot: candidate.slot, state: 'spent', until });
          return result;
        } catch (error) {
          if (!isRetryable(error)) {
            onKey?.({ slot: candidate.slot, state: 'ready' });
            throw error;
          }
          last = error;
          const until = now() + cooldownFor(error);
          cooldowns.set(candidate.slot, until);
          // Red at once even when the cooldown is zero, which is how a rejected
          // request stays visible.
          onKey?.({ slot: candidate.slot, state: 'cooling', reason: error.code, until: Math.max(until, now() + 5_000) });
          // Half an answer from one model is not a prefix of another's.
          if (emitted) args.onRestart?.();
          if (step === attempt.length - 1) throw error;
        }
      }

      throw last || new ProviderError('No provider answered.', { code: 'unknown' });
    },
  };

  return { provider, candidates, cooldowns };
}
