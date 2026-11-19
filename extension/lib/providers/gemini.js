/**
 * Google Gemini through its OpenAI-compatible endpoint.
 *
 * The free tier is keyed per Google account, so it is the second place to go
 * when Groq's tokens-per-minute run out mid-page.
 */

import { createOpenAIProvider } from './openai.js';

export const gemini = createOpenAIProvider({
  id: 'gemini',
  label: 'Gemini',
  keyHint: 'aistudio.google.com/apikey',
  chatEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/models',

  models: [
    {
      id: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      note: 'Free tier · tool use',
      tag: 'default',
      vision: true,
    },
    {
      id: 'gemini-2.5-flash-lite',
      label: 'Gemini 2.5 Flash Lite',
      note: 'Cheapest, fastest',
      vision: true,
    },
  ],
});
