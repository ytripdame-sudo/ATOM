/**
 * Groq adapter — OpenAI-compatible chat completions with SSE streaming,
 * including streamed tool calls.
 *
 * Model IDs verified against console.groq.com/docs/models, November 2026.
 * Note for anyone editing this list: `groq/compound` and `groq/compound-mini`
 * were decommissioned on 2026-09-21, and the Llama 3.1/3.3 IDs are now
 * Enterprise-only. Do not "restore" them from older docs.
 */

const CHAT_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS_ENDPOINT = 'https://api.groq.com/openai/v1/models';

export class ProviderError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
  }
}

export const groq = {
  id: 'groq',
  label: 'Groq',
  keyHint: 'console.groq.com/keys',

  models: [
    {
      id: 'openai/gpt-oss-120b',
      label: 'GPT-OSS 120B',
      note: 'Best reasoning · tool use',
      tag: 'default',
    },
    {
      id: 'openai/gpt-oss-20b',
      label: 'GPT-OSS 20B',
      note: 'Fastest and cheapest',
    },
    {
      id: 'qwen/qwen3.8-27b',
      label: 'Qwen 3.8 27B',
      note: 'Multimodal · parallel tools',
    },
  ],

  /**
   * @returns {Promise<{ text: string, finishReason: string, toolCalls: Array }>}
   */
  async streamChat({ apiKey, model, messages, signal, onDelta, tools }) {
    if (!apiKey) throw new ProviderError('No API key', { code: 'auth' });

    const body = { model, messages, stream: true };
    if (Array.isArray(tools) && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    let response;
    try {
      response = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ProviderError(err?.message || 'Network request failed', { code: 'network' });
    }

    if (!response.ok) {
      let detail = '';
      try {
        const errorBody = await response.json();
        detail = errorBody?.error?.message || errorBody?.message || '';
      } catch {
        /* non-JSON error body */
      }
      const code =
        response.status === 401 || response.status === 403
          ? 'auth'
          : response.status === 429
            ? 'rate_limit'
            : '';
      throw new ProviderError(detail || `Groq returned ${response.status}`, {
        status: response.status,
        code,
      });
    }

    if (!response.body) throw new ProviderError('Streaming is unavailable', { code: 'stream' });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let finishReason = 'end';
    const toolCalls = [];

    // Tool call arguments arrive as fragments spread across chunks: index,
    // id and name once, then pieces of a JSON string to concatenate.
    const absorbToolCalls = (fragments) => {
      for (const fragment of fragments) {
        const index = Number.isInteger(fragment?.index) ? fragment.index : toolCalls.length;
        const call = (toolCalls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });

        if (typeof fragment?.id === 'string' && fragment.id) call.id = fragment.id;
        if (typeof fragment?.type === 'string' && fragment.type) call.type = fragment.type;

        const name = fragment?.function?.name;
        if (typeof name === 'string' && name) call.function.name += name;

        const args = fragment?.function?.arguments;
        if (typeof args === 'string') call.function.arguments += args;
      }
    };

    const finish = () => ({
      text,
      finishReason,
      toolCalls: toolCalls
        .filter(Boolean)
        .map((call, index) => ({
          id: call.id || `call_${index}`,
          type: 'function',
          function: { name: call.function.name, arguments: call.function.arguments || '{}' },
        })),
    });

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;

          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return finish();

          let chunk;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }

          if (chunk?.error) {
            throw new ProviderError(chunk.error.message || 'Groq stream error', {
              code: typeof chunk.error.code === 'string' ? chunk.error.code : '',
            });
          }

          const choice = chunk?.choices?.[0];
          const delta = choice?.delta;

          if (Array.isArray(delta?.tool_calls)) absorbToolCalls(delta.tool_calls);

          if (typeof delta?.content === 'string' && delta.content) {
            text += delta.content;
            onDelta(delta.content);
          }

          if (choice?.finish_reason) finishReason = choice.finish_reason;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }

    return finish();
  },

  /** Cheap liveness check that only asks Groq whether the key is accepted. */
  async verifyKey(apiKey) {
    if (!apiKey) return { ok: false, detail: 'No key' };
    try {
      const response = await fetch(MODELS_ENDPOINT, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (response.ok) return { ok: true };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, detail: 'Groq rejected this key' };
      }
      return { ok: false, detail: `Groq returned ${response.status}` };
    } catch (err) {
      return { ok: false, detail: err?.message || 'Network error' };
    }
  },
};
