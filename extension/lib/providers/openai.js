/**
 * One OpenAI-compatible chat adapter, configured per vendor.
 *
 * Groq, Gemini's compatibility layer and OpenRouter all speak the same shape:
 * `/chat/completions` with SSE deltas and streamed tool calls. Writing the
 * parser once means a new free provider is a URL, a model list and a key field
 * — not another copy of the streaming loop to keep in sync.
 */

export class ProviderError extends Error {
  constructor(message, { status = 0, code = '', retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * What a failure means for the user's quota. `too_large` is the one that bit
 * this project first: a request bigger than the free tier's tokens-per-minute
 * is not a bad key and not a bad model — it is a request that must shrink.
 */
export function classifyStatus(status, message = '') {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 402 || /insufficient|quota exceeded|out of credits/i.test(message)) return 'quota';
  if (
    status === 413 ||
    /request too large|tokens per minute|context[_ ]length[_ ]exceeded|maximum context length|reduce your message size/i.test(
      message,
    )
  ) {
    return 'too_large';
  }
  if (status === 404) return 'model_missing';
  return '';
}

/** Whether another provider or key could plausibly answer instead. */
export function isRetryable(error) {
  const code = error?.code || '';
  if (['auth', 'rate_limit', 'quota', 'too_large', 'model_missing'].includes(code)) return true;
  const status = Number(error?.status) || 0;
  return status === 401 || status === 402 || status === 403 || status === 404 || status === 413 || status === 429;
}

export function createOpenAIProvider(config) {
  const label = config.label;

  return {
    id: config.id,
    label,
    keyHint: config.keyHint,
    // A local server wants no key; a hosted one always does.
    needsKey: config.needsKey !== false,
    chatEndpoint: config.chatEndpoint,
    modelsEndpoint: config.modelsEndpoint,
    models: config.models,
    /** Extra headers a vendor wants (OpenRouter likes an app name). */
    extraHeaders: config.extraHeaders || {},

    async streamChat({ apiKey, model, messages, signal, onDelta, onReasoning, tools, reasoningEffort }) {
      if (!apiKey && config.needsKey !== false) throw new ProviderError(`No ${label} key`, { code: 'auth' });

      const body = { model, messages, stream: true };
      if (Number.isInteger(config.maxCompletionTokens) && config.maxCompletionTokens > 0) {
        body.max_completion_tokens = config.maxCompletionTokens;
      }
      if (Array.isArray(tools) && tools.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }
      // Only sent when deep think is on: a vendor that does not know the field
      // rejects the whole request, and most of them do not.
      if (reasoningEffort) body.reasoning_effort = reasoningEffort;

      let response;
      try {
        response = await fetch(config.chatEndpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            ...config.extraHeaders,
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
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new ProviderError(detail || `${label} returned ${response.status}`, {
          status: response.status,
          code: classifyStatus(response.status, detail),
          retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.round(retryAfter * 1000) : 0,
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
              const message = chunk.error.message || `${label} stream error`;
              throw new ProviderError(message, {
                code: classifyStatus(0, message) || (typeof chunk.error.code === 'string' ? chunk.error.code : ''),
              });
            }

            const choice = chunk?.choices?.[0];
            const delta = choice?.delta;

            if (Array.isArray(delta?.tool_calls)) absorbToolCalls(delta.tool_calls);

            // Reasoning models stream their thinking beside the answer, under
            // `reasoning` (Groq, OpenRouter) or `reasoning_content` (DeepSeek).
            // When a vendor hides it, nothing arrives and nothing is invented.
            const reasoning = typeof delta?.reasoning === 'string' ? delta.reasoning : delta?.reasoning_content;
            if (typeof reasoning === 'string' && reasoning) onReasoning?.(reasoning);

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

    /** Cheap liveness check that only asks whether the key is accepted. */
    async verifyKey(apiKey) {
      if (!apiKey && config.needsKey === false) return { ok: true };
      if (!apiKey) return { ok: false, detail: 'No key' };
      try {
        const response = await fetch(config.modelsEndpoint, {
          headers: { authorization: `Bearer ${apiKey}`, ...config.extraHeaders },
        });
        if (response.ok) return { ok: true };
        if (response.status === 401 || response.status === 403) {
          return { ok: false, detail: `${label} rejected this key` };
        }
        return { ok: false, detail: `${label} returned ${response.status}` };
      } catch (err) {
        return { ok: false, detail: err?.message || 'Network error' };
      }
    },
  };
}
