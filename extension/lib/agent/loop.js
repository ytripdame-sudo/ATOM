/**
 * The tool loop: stream an answer; if the model asks for tools, run them and
 * ask again with the results; stop when it answers or when the step budget runs
 * out (spec §12 — a small, fast model needs orchestration, and every step costs
 * the user money, so there is a hard ceiling).
 *
 * Everything effectful is injected, so this file stays testable.
 */

export const MAX_STEPS = 6;

/**
 * @param {object} options
 * @param {{streamChat: Function}} options.provider
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {Array|null} options.tools
 * @param {AbortSignal} [options.signal]
 * @param {() => Array} options.buildMessages   provider-formatted history
 * @param {() => object} options.beginStep      creates the assistant message for this step
 * @param {(call: object) => Promise<void>} options.runTool
 * @param {number} [options.maxSteps]
 */
export async function runAgentTurn(options) {
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const tools = options.tools && options.tools.length ? options.tools : undefined;

  for (let step = 1; step <= maxSteps; step += 1) {
    // Stopping between steps must not start another paid request.
    if (options.signal?.aborted) return { steps: step - 1, stopped: true };

    const turn = options.beginStep();
    let result;

    try {
      result = await options.provider.streamChat({
        apiKey: options.apiKey,
        model: options.model,
        messages: options.buildMessages(),
        tools,
        signal: options.signal,
        onDelta: (chunk) => turn.push(chunk),
      });
    } catch (error) {
      await turn.finish({ text: turn.text(), toolCalls: [], failed: true, error });
      throw error;
    }

    const calls = Array.isArray(result?.toolCalls) ? result.toolCalls.filter((call) => call?.function?.name) : [];
    await turn.finish({ text: result?.text || '', toolCalls: calls });

    if (!calls.length) return { steps: step, complete: true };

    for (const call of calls) {
      if (options.signal?.aborted) return { steps: step, stopped: true };
      await options.runTool(call);
    }
  }

  return { steps: maxSteps, exhausted: true };
}
