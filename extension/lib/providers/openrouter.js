/**
 * OpenRouter — one key, many models, several of them free.
 *
 * The free model ids on OpenRouter change more often than any other vendor's:
 * if one disappears, edit this list; the adapter needs nothing else. Free
 * models are rate-limited per key, so a second key in the pool genuinely adds
 * headroom.
 */

import { createOpenAIProvider } from './openai.js';

export const openrouter = createOpenAIProvider({
  id: 'openrouter',
  label: 'OpenRouter',
  keyHint: 'openrouter.ai/keys',
  chatEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
  modelsEndpoint: 'https://openrouter.ai/api/v1/models',
  extraHeaders: {
    'HTTP-Referer': 'https://github.com/atom-sidepanel',
    'X-Title': 'ATOM',
  },

  models: [
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      label: 'Llama 3.3 70B (free)',
      note: 'Free tier · tool use',
      tag: 'default',
    },
    {
      id: 'deepseek/deepseek-chat-v3-0324:free',
      label: 'DeepSeek V3 (free)',
      note: 'Free tier · tool use',
    },
  ],
});
