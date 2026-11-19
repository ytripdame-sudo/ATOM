/**
 * Groq — OpenAI-compatible chat completions with SSE streaming, including
 * streamed tool calls.
 *
 * Model IDs verified against console.groq.com/docs/models, November 2026.
 * Note for anyone editing this list: `groq/compound` and `groq/compound-mini`
 * were decommissioned on 2026-09-21, and the Llama 3.1/3.3 IDs are now
 * Enterprise-only. Do not "restore" them from older docs.
 */

import { createOpenAIProvider } from './openai.js';

export { ProviderError } from './openai.js';

export const groq = createOpenAIProvider({
  id: 'groq',
  label: 'Groq',
  keyHint: 'console.groq.com/keys',
  chatEndpoint: 'https://api.groq.com/openai/v1/chat/completions',
  modelsEndpoint: 'https://api.groq.com/openai/v1/models',
  // Free Groq keys can carry a 1,000-token output limit per minute. Leaving the
  // field out lets Groq reserve its full default and rejects the request.
  maxCompletionTokens: 900,

  models: [
    {
      id: 'openai/gpt-oss-120b',
      label: 'GPT-OSS 120B',
      note: 'Best reasoning · tool use',
      tag: 'default',
      // Groq accepts reasoning_effort for this family, so deep think maps to a
      // real setting instead of a prompt-only wish.
      reasoning: true,
    },
    {
      id: 'openai/gpt-oss-20b',
      label: 'GPT-OSS 20B',
      note: 'Fastest and cheapest',
      reasoning: true,
    },
    {
      id: 'qwen/qwen3.8-27b',
      label: 'Qwen 3.8 27B',
      note: 'Multimodal · parallel tools',
      vision: true,
    },
  ],
});
