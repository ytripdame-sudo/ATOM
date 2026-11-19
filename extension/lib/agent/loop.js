/**
 * The tool loop: stream an answer; if the model asks for tools, run them and
 * ask again with the results; stop when it answers or when the step budget runs
 * out (spec §12 — a small, fast model needs orchestration, and every step costs
 * the user money, so there is a hard ceiling).
 *
 * Everything effectful is injected, so this file stays testable.
 */

export const MAX_STEPS = 12;

/**
 * A 429 is not a dead end: Groq's free tiers count tokens per minute, and a
 * turn with a long page in it can cross that line mid-conversation. Waiting out
 * the reset and asking the same step again is what a person would do, so the
 * loop does it — twice, then gives up honestly.
 */
/**
 * Repeating a call that already ran changes nothing, so three identical calls
 * is a loop rather than a retry: the turn ends there instead of spending what
 * is left of the budget asking the same question.
 */
export const REPEAT_LIMIT = 2;

/**
 * Scroll is the cheapest call to spam and the most tempting substitute for
 * reading again, so a run of them with no other call between counts as stuck
 * even when each one differs from the last.
 */
export const SCROLL_RUN_LIMIT = 4;

export const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_WAIT_BASE = 3000;
const RATE_LIMIT_WAIT_CAP = 45000;

/** How long to wait before asking again, or null when this is the last word. */
function rateLimitWaitMs(error, attempt) {
  const limited = error?.code === 'rate_limit' || error?.status === 429;
  if (!limited || attempt >= RATE_LIMIT_RETRIES) return null;
  const suggested = Number(error?.retryAfterMs) || 0;
  return Math.min(RATE_LIMIT_WAIT_CAP, suggested > 0 ? suggested : RATE_LIMIT_WAIT_BASE * (attempt + 1));
}

/** Resolve after ms, or early when the turn is stopped. False means stopped. */
function waitFor(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => done(true), ms);
    const done = (kept) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(kept);
    };
    const onAbort = () => done(false);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * @param {object} options
 * @param {{streamChat: Function}} options.provider
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {Array|null} options.tools
 * @param {AbortSignal} [options.signal]
 * @param {() => Array} options.buildMessages   provider-formatted history
 * @param {() => object} options.beginStep      creates the assistant message for this step
 * @param {(info: {attempt: number, maxAttempts: number, waitMs: number}) => void} [options.onRateLimit]
 * @param {(call: object) => Promise<void>} options.runTool
 * @param {number} [options.maxSteps]
 */
export async function runAgentTurn(options) {
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const tools = options.tools && options.tools.length ? options.tools : undefined;
  // What already ran this turn, keyed by name and arguments, plus how many
  // scrolls have gone by since the last call of any other kind.
  const seen = new Map();
  let scrollRun = 0;

  for (let step = 1; step <= maxSteps; step += 1) {
    // A paused task waits here, between steps, where stopping is clean.
    await options.beforeStep?.();
    // Stopping between steps must not start another paid request.
    if (options.signal?.aborted) return { steps: step - 1, stopped: true };

    const turn = options.beginStep();
    let result;
    let attempt = 0;
    // One free rescue for the common free-tier wall: the same step, with a
    // smaller history, before the turn is allowed to fail.
    let shrunk = false;

    for (;;) {
      try {
        result = await options.provider.streamChat({
          apiKey: options.apiKey,
          model: options.model,
          messages: options.buildMessages(shrunk ? { shrink: true } : undefined),
          tools,
          // Only a model whose vendor accepts the field gets one.
          reasoningEffort: options.reasoningEffort,
          signal: options.signal,
          onDelta: (chunk) => turn.push(chunk),
          onReasoning: (chunk) => turn.reason?.(chunk),
          // The provider pool calls this when it moves to another key or model
          // after some text already arrived.
          onRestart: () => turn.reset?.(),
        });
        break;
      } catch (error) {
        if (error?.code === 'too_large' && !shrunk) {
          shrunk = true;
          if (turn.text()) turn.reset?.();
          options.onShrink?.();
          continue;
        }

        const waitMs = rateLimitWaitMs(error, attempt);
        if (waitMs === null) {
          await turn.finish({ text: turn.text(), toolCalls: [], failed: true, error });
          throw error;
        }
        attempt += 1;
        options.onRateLimit?.({ attempt, maxAttempts: RATE_LIMIT_RETRIES, waitMs });
        // The empty reply is reused, so a retry never leaves a second message
        // behind or replays a tool call that already ran.
        if (!(await waitFor(waitMs, options.signal))) {
          await turn.finish({ text: '', toolCalls: [] });
          return { steps: step - 1, stopped: true };
        }
        // The same step is about to be asked again into the same message.
        if (turn.text()) turn.reset?.();
      }
    }

    // Calls without a name cannot be run or answered, so they never count.
    const calls = (result?.toolCalls ?? []).filter((call) => call?.function?.name);
    await turn.finish({ text: result?.text || '', toolCalls: calls });

    if (!calls.length) return { steps: step, complete: true };

    for (const call of calls) {
      // A pause during one call takes effect before the next, never inside it.
      await options.beforeStep?.();
      if (options.signal?.aborted) return { steps: step, stopped: true };

      const name = call.function.name;
      const signature = `${name}:${call.function.arguments ?? ''}`;
      const repeats = seen.get(signature) ?? 0;
      seen.set(signature, repeats + 1);
      scrollRun = name === 'scroll' ? scrollRun + 1 : 0;

      // A repeat is the model asking the same question again, and a scroll run
      // is it looking for something scrolling cannot reveal. Neither is worth
      // a step: the call is handed over unrun so the panel can show why, and
      // the turn ends with a reason the caller can put into words.
      if (repeats >= REPEAT_LIMIT || scrollRun >= SCROLL_RUN_LIMIT) {
        const reason = scrollRun >= SCROLL_RUN_LIMIT ? 'scroll' : 'repeat';
        await options.runTool(call, { skipped: reason });
        return { steps: step, stalled: true, reason };
      }

      await options.runTool(call);
    }
  }

  return { steps: maxSteps, exhausted: true };
}
