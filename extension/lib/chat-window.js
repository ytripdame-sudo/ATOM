/**
 * A long conversation is not all drawn at once. The newest page is what anyone
 * is reading; older pages are a button, not a scroll performance problem.
 *
 * Pure, so the boundary is testable without a browser.
 */
export const PAGE = 40;

/**
 * @param {Array} messages the whole conversation, oldest first
 * @param {number} [limit] how many of the newest to draw
 * @returns {{messages: Array, hidden: number}} hidden counts what is above
 */
export function windowMessages(messages, limit = PAGE) {
  const list = Array.isArray(messages) ? messages : [];
  const count = Math.max(PAGE, Math.floor(Number(limit) || PAGE));
  if (list.length <= count) return { messages: list, hidden: 0 };
  return { messages: list.slice(-count), hidden: list.length - count };
}

/** One page more than the last render, for the "Show earlier" button. */
export function nextLimit(limit) {
  return Math.max(PAGE, Math.floor(Number(limit) || PAGE)) + PAGE;
}
