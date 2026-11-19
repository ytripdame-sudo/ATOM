/**
 * Trusted actions: "don't ask again" for one action on one site (spec §9).
 *
 * A grant is a narrow, revocable exception to the confirmation wall. It is
 * deliberately unable to cover the three floors, and the rules live here rather
 * than in the UI so a stale entry or a hand-edited setting cannot widen them:
 *
 *   - submitting a form (typing with `submit`, or a known submit control);
 *   - typing into a password, card or one-time-code field;
 *   - navigating (or following a link) off the origin the grant belongs to.
 *
 * Nothing here reads Chrome or settings: the caller passes the settings array
 * in and stores the result, so this is all testable as plain data.
 */

import { SENSITIVE_FIELDS } from './agent/policy.js';

/** The actions a site can be trusted with. `submit` is not one of them. */
export const GRANT_KINDS = ['click', 'type_text', 'select_option', 'scroll', 'navigate'];

export const GRANT_LABELS = {
  click: 'clicking',
  type_text: 'typing',
  select_option: 'choosing options',
  scroll: 'scrolling',
  navigate: 'opening pages',
};

/** Enough for a long browser history of favourites, small enough to stay sane. */
export const MAX_GRANTS = 100;

export function normalizeGrants(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const grants = [];

  for (const entry of raw) {
    const host = hostOf(entry?.host);
    const kind = String(entry?.kind || '').trim();
    if (!host || !GRANT_KINDS.includes(kind)) continue;
    const key = `${host}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grants.push({ host, kind, at: Number(entry?.at) || 0 });
    if (grants.length >= MAX_GRANTS) break;
  }

  return grants;
}

export function hasGrant(grants, host, kind) {
  const wanted = hostOf(host);
  return normalizeGrants(grants).some((grant) => grant.host === wanted && grant.kind === kind);
}

export function addGrant(grants, { host, kind } = {}) {
  const clean = normalizeGrants(grants);
  const wanted = hostOf(host);
  if (!wanted || !GRANT_KINDS.includes(kind)) return clean;
  if (clean.some((grant) => grant.host === wanted && grant.kind === kind)) return clean;
  return normalizeGrants([...clean, { host: wanted, kind, at: Date.now() }]);
}

export function removeGrant(grants, { host, kind } = {}) {
  const wanted = hostOf(host);
  return normalizeGrants(grants).filter((grant) => !(grant.host === wanted && grant.kind === kind));
}

/**
 * What this confirmation may offer to remember — or null, when the honest
 * answer is "nothing about this may be remembered".
 *
 * @param {object} input
 * @param {string} input.tool
 * @param {object} [input.args]        parsed tool arguments
 * @param {{kind?:string, href?:string, sensitive?:string, submits?:boolean}} [input.refMeta]
 * @param {string} [input.pageUrl]     the page the action runs on
 * @param {string} [input.targetUrl]   where a navigate is going
 * @returns {{kind:string, host:string, label:string}|null}
 */
export function grantOffer({ tool, args = {}, refMeta = null, pageUrl = '', targetUrl = '' }) {
  if (!GRANT_KINDS.includes(tool)) return null;
  const host = hostOf(pageUrl);
  if (!host) return null;

  if (tool === 'type_text') {
    // Sending a form and filling a secret are the two floors typing has.
    if (args?.submit) return null;
    if (SENSITIVE_FIELDS.has(refMeta?.sensitive)) return null;
  }

  if (tool === 'click') {
    // A control that submits, and a link that leaves the site, are never
    // covered by "don't ask about clicks here".
    if (refMeta?.submits) return null;
    if (leavesSite(refMeta?.href, pageUrl)) return null;
  }

  if (tool === 'navigate' && (!targetUrl || leavesSite(targetUrl, pageUrl))) return null;

  return { kind: tool, host, label: GRANT_LABELS[tool] };
}

/** True when a stored grant covers this exact action. Re-checks the floors. */
export function grantCovers({ grants, tool, args = {}, refMeta = null, pageUrl = '', targetUrl = '' }) {
  const offer = grantOffer({ tool, args, refMeta, pageUrl, targetUrl });
  if (!offer) return false;
  return hasGrant(grants, offer.host, offer.kind);
}

/** A stored grant holds a bare host; callers may hand over a whole URL. */
function hostOf(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).host;
    } catch {
      return '';
    }
  }
  return /^[a-z0-9.-]+(:[0-9]+)?$/.test(raw) ? raw : '';
}

/** Whether following `target` would leave the origin of `pageUrl`. */
function leavesSite(target, pageUrl) {
  if (!target) return false;
  const from = originOf(pageUrl);
  const to = originOf(target, pageUrl);
  return Boolean(from) && Boolean(to) && from !== to;
}

function originOf(value, base = '') {
  try {
    const url = new URL(String(value || '').trim(), base || undefined);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}
