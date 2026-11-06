'use strict';

// Minimal keyless Socrata (SODA) client. Host is FIXED per adapter (never
// caller-arbitrary), so there is no SSRF surface here. An app token is optional
// and only raises the anonymous throttle; we run keyless by default.

function soqlQuote(v) {
  // SoQL string literals are single-quoted; escape embedded quotes by doubling.
  return String(v).replace(/'/g, "''");
}

async function sodaGet(baseUrl, params, { fetchImpl, timeoutMs = 15000, appToken } = {}) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new Error('no fetch implementation available');
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers = { 'User-Agent': 'us-business-verification/0.1 (+apify actor)', Accept: 'application/json' };
  if (appToken) headers['X-App-Token'] = appToken;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url.toString(), { headers, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Socrata HTTP ${res.status}`);
      err.status = res.status;
      err.body = body.slice(0, 300);
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Two-pass candidate fetch against one Socrata dataset:
 *   1. exact case-insensitive match on the name field (cheapest, highest precision)
 *   2. if empty, full-text $q on the name token (recall for formatting variants)
 * Returns a de-duplicated array of raw rows (capped).
 */
async function fetchCandidates(baseUrl, { nameField, idField, name, limit = 25, opts = {} }) {
  const core = String(name).trim();
  const out = [];
  const seen = new Set();
  const push = (rows) => {
    for (const r of rows || []) {
      const id = idField ? r[idField] : JSON.stringify(r);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(r);
    }
  };

  // Track pass outcomes so a TOTAL source failure can be surfaced to the caller
  // (not silently flattened into an empty "not_found"): the honest no-match-reason
  // distinction depends on telling an outage from a clean miss.
  let passesRun = 0;
  let passesErrored = 0;
  let lastErr = null;

  // Pass 1: exact (case-insensitive)
  passesRun += 1;
  try {
    const exact = await sodaGet(baseUrl, {
      $where: `upper(${nameField})=upper('${soqlQuote(core)}')`,
      $limit: String(Math.min(limit, 10)),
    }, opts);
    push(exact);
  } catch (e) { passesErrored += 1; lastErr = e; /* fall through to full-text */ }

  // Pass 2: full-text recall (only the strongest few are kept after scoring)
  if (out.length < 5) {
    passesRun += 1;
    try {
      const ft = await sodaGet(baseUrl, { $q: core, $limit: String(limit) }, opts);
      push(ft);
    } catch (e) { passesErrored += 1; lastErr = e; /* keep whatever pass 1 found */ }
  }

  // If every pass we ran errored and nothing came back, this is an OUTAGE, not a
  // miss. Throw so the orchestrator records a source_error attempt rather than a
  // false "not_found" (a buyer must never read an outage as "not registered").
  if (passesErrored >= passesRun && out.length === 0) {
    const err = new Error(`Socrata source unavailable${lastErr ? `: ${lastErr.message}` : ''}`);
    err.sourceOutage = true;
    throw err;
  }
  return out.slice(0, limit);
}

module.exports = { sodaGet, fetchCandidates, soqlQuote };
