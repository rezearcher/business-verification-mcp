'use strict';

// Keyless GLEIF corporate-ownership graph — the "who ultimately owns this company,
// and what does it own?" surface, built on the GLEIF Global LEI relationship
// register. GLEIF publishes Level-1 (entity) AND Level-2 (relationship / ownership)
// data as CC0 1.0 public-domain open data (api.gleif.org, no key, no login).
//
// Terms read 2026-11-12: https://www.gleif.org/en/lei-data/access-and-use-lei-data
// — LEI data (incl. relationship records) is free of charge under CC0 1.0 Universal
// (public domain). Keyless, commercial use permitted, no attribution required (we
// attribute anyway, honestly). Relationship records are reported by the entity and
// validated by GLEIF, so a direct-parent / ultimate-parent edge is an accountable
// corporate-control statement, not a guess.
//
// CRITICAL MECHANIC: GLEIF returns 400/empty bodies unless the request carries
// `Accept: application/vnd.api+json`. Every call below sets it.
//
// THE WEDGE over the flat single-hop scrapers in this lane:
//   1. PARENT CHAIN — we walk direct-parent iteratively up to the ultimate parent,
//      so the output is a real multi-level control chain (the UBO anchor), not one hop.
//   2. REGISTEREDAS JOIN — every GLEIF entity carries `registeredAs` = its authoritative
//      national-register number (e.g. a French SIREN, a German HRB). We surface, per node,
//      which national register could confirm it — the connected-intelligence link between
//      the global ownership graph and a per-country registry that no flat LEI scraper joins.
//
// Honesty guards: a 404 on a relationship endpoint means "no such edge reported"
// (e.g. a root company has no parent) — returned as null, never an error and never
// a fabricated edge. A name->LEI resolution is only accepted on a strong leading-token
// agreement, so "Acme" never silently resolves to "Acme Global Holdings AG".

const UA = 'GreyRidgeSignals-KYB-MCP/0.7 (+https://greyridgesignals.ai)';
const BASE = 'https://api.gleif.org/api/v1';
const ACCEPT = 'application/vnd.api+json';

// registeredAs-shape -> which national register our hosted rail can cross-check.
// Label/hint only (degrades open: an unrecognised shape returns null), never a gate.
function nationalRegisterHint(registeredAs, country) {
  const raw = String(registeredAs || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  const c = String(country || '').toUpperCase();
  if (c === 'FR' || /^\d{9}$/.test(digits)) {
    if (/^\d{9}$/.test(digits)) return { register: 'FR / INSEE SIRENE (SIREN)', number: digits, joinable: true };
  }
  if (c === 'NO' && /^\d{9}$/.test(digits)) return { register: 'NO / Brønnøysund (org.nr)', number: digits, joinable: true };
  if (c === 'CZ' && digits) return { register: 'CZ / ARES (IČO)', number: digits, joinable: true };
  if (c === 'FI' && raw) return { register: 'FI / PRH (business ID)', number: raw, joinable: true };
  if (c === 'PL' && digits) return { register: 'PL / KRS', number: digits, joinable: true };
  if (c === 'DE' || /^HR[AB]/i.test(raw)) return { register: 'DE / Handelsregister (HRA/HRB)', number: raw, joinable: false };
  // Known shape but outside our native coverage — honest: not joinable yet.
  return { register: null, number: raw, joinable: false };
}

class GleifError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'GleifError'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { status, json }. 404 -> { status:404, json:null } (a non-error "no edge").
// Honors a hard per-call timeout and a small retry on transient upstream failures.
async function getJson(url, { timeoutMs = 9000, tries = 2 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: ACCEPT }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      last = new GleifError('UPSTREAM', `network error: ${e && e.message ? e.message : e}`);
      await sleep(250 * (i + 1));
      continue;
    }
    if (res.status === 404) return { status: 404, json: null };
    if (res.status === 429 || res.status >= 500) {
      last = new GleifError('UPSTREAM', `HTTP ${res.status} from api.gleif.org`);
      await sleep(400 * (i + 1));
      continue;
    }
    if (!res.ok) throw new GleifError('UPSTREAM', `HTTP ${res.status} from api.gleif.org`);
    let j;
    try { j = await res.json(); } catch { throw new GleifError('BAD_JSON', 'non-JSON body from api.gleif.org'); }
    return { status: res.status, json: j };
  }
  throw last || new GleifError('UPSTREAM', 'api.gleif.org unreachable');
}

function normalizeLei(rec, { withHint = false } = {}) {
  if (!rec || typeof rec !== 'object') return null;
  const a = rec.attributes || {};
  const e = a.entity || {};
  const raId = (e.registeredAt || {}).id || null;
  const statusRaw = e.status || null;
  const country = (e.legalAddress || {}).country || (e.headquartersAddress || {}).country || null;
  const registeredAs = e.registeredAs || null;
  const out = {
    lei: rec.id || null,
    name: (e.legalName || {}).name || null,
    country,
    status: statusRaw === 'ACTIVE' ? 'active' : statusRaw === 'INACTIVE' ? 'inactive' : (statusRaw ? String(statusRaw).toLowerCase() : null),
    registered_as: registeredAs,
    registration_authority_id: raId,
    source_url: rec.id ? `https://search.gleif.org/#/record/${rec.id}` : null,
  };
  if (withHint) out.national_register = nationalRegisterHint(registeredAs, country);
  return out;
}

// --- Leading-token name-agreement guard (keeps "Acme" from resolving to a holding co.) ---
function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !['inc', 'llc', 'ltd', 'corp', 'co', 'sa', 'ag', 'gmbh', 'plc', 'the', 'and'].includes(t));
}
function leadingAgreement(query, candidate) {
  const q = tokens(query);
  const c = tokens(candidate);
  if (!q.length || !c.length) return 0;
  let n = 0;
  for (let i = 0; i < q.length && i < c.length; i++) { if (q[i] === c[i]) n++; else break; }
  return n / q.length;
}

async function resolveLei(name, { timeoutMs = 9000 } = {}) {
  const url = `${BASE}/fuzzycompletions?field=entity.legalName&q=${encodeURIComponent(name)}`;
  const { json } = await getJson(url, { timeoutMs });
  const cands = [];
  for (const d of (json && json.data) || []) {
    const value = (d.attributes || {}).value;
    const lei = (((d.relationships || {})['lei-records'] || {}).data || {}).id;
    if (lei) cands.push({ value, lei, agreement: leadingAgreement(name, value) });
  }
  cands.sort((a, b) => b.agreement - a.agreement);
  const best = cands[0];
  // Require the query's leading tokens to be fully present at the head of the match.
  if (!best || best.agreement < 0.999) return { lei: null, candidate: best || null, candidates: cands.slice(0, 5) };
  return { lei: best.lei, candidate: best, candidates: cands.slice(0, 5) };
}

async function fetchRecord(lei, { timeoutMs = 9000, withHint = true } = {}) {
  const { json } = await getJson(`${BASE}/lei-records/${encodeURIComponent(lei)}`, { timeoutMs });
  return json && json.data ? normalizeLei(json.data, { withHint }) : null;
}

// Single-record relationship endpoint (direct-parent / ultimate-parent). null if no edge.
async function relationParent(lei, which, { timeoutMs = 9000 } = {}) {
  const { status, json } = await getJson(`${BASE}/lei-records/${encodeURIComponent(lei)}/${which}`, { timeoutMs });
  if (status === 404 || !json || !json.data) return null;
  return normalizeLei(json.data, { withHint: true });
}

// Walk direct-parent iteratively to build the real control chain (the multi-level wedge).
// Cycle-guarded and hop-capped so it always terminates fast.
async function parentChain(lei, { maxHops = 6, timeoutMs = 9000 } = {}) {
  const chain = [];
  const seen = new Set([lei]);
  let cur = lei;
  for (let i = 0; i < maxHops; i++) {
    const p = await relationParent(cur, 'direct-parent', { timeoutMs });
    if (!p || !p.lei || seen.has(p.lei)) break;
    chain.push(p);
    seen.add(p.lei);
    cur = p.lei;
  }
  return chain;
}

// Direct children: one bounded page + the TRUE total from GLEIF pagination meta.
async function directChildren(lei, { limit = 10, timeoutMs = 9000 } = {}) {
  const size = Math.min(Math.max(1, limit), 25);
  const url = `${BASE}/lei-records/${encodeURIComponent(lei)}/direct-children?page%5Bsize%5D=${size}&page%5Bnumber%5D=1`;
  const { status, json } = await getJson(url, { timeoutMs });
  if (status === 404 || !json) return { total: 0, sample: [] };
  const total = (((json.meta || {}).pagination || {}).total) ?? ((json.data || []).length);
  const sample = (json.data || []).map((r) => normalizeLei(r, { withHint: true })).filter(Boolean);
  return { total: Number(total) || sample.length, sample };
}

module.exports = {
  resolveLei,
  fetchRecord,
  relationParent,
  parentChain,
  directChildren,
  nationalRegisterHint,
  normalizeLei,
  GleifError,
};
