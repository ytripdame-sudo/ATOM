/**
 * What the model is told when an action could not run.
 *
 * The wording is the whole point: a model that retries a dead ref spends a step
 * and the user's money to fail again, and a model without page access cannot
 * succeed at all however many times it tries. So each of these says what did
 * *not* happen, names the one next move (`read_page`), and forbids the repeat.
 *
 * They travel inside a tool result, so `lib/fence.js` fences them like any other
 * tool output; only the ref and the host are interpolated, both already resolved
 * by the worker.
 */

/** A ref that no longer points at anything: the page changed under it. */
export function staleFailure(ref) {
  const name = String(ref || 'That ref');
  return `${name} does not match anything on the page now, so nothing happened. Refs expire whenever the page changes. Call read_page, then act on a ref from that result; do not repeat this action with ${name}. If the control you wanted is gone, tell the user instead of guessing.`;
}

/** No host permission for this site: reading and acting are both refused. */
export function noAccessFailure(host) {
  const where = String(host || 'this site');
  return `Page access is not granted for ${where}, so the page was not read and nothing was changed. Do not retry this action — it cannot succeed until the user grants access. Ask them to use Grant access on this step, then call read_page before acting again. Do not describe the page or claim to have read it.`;
}
