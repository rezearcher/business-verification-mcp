'use strict';

// OFAC sanctions screen — buyer-ladder STEP 4 (entity -> UCC -> court -> TIN ->
// SANCTIONS). Given a verified business name (and, optionally, its registered
// agent), this screens it against the U.S. Treasury OFAC Specially Designated
// Nationals (SDN) list plus every aka/fka alias, and returns a conservative
// verdict (clear | potential_match | match) with each hit's sanctions program,
// list, match_confidence/tier, and the exact OFAC source URL.
//
// Source terms: the OFAC SDN and alias files are a work of the U.S. Government
// (17 U.S.C. sec. 105 -> not copyrightable, public domain) published keyless by
// Treasury expressly for public sanctions-compliance screening. No API key, no
// licence fee, no registration. Reviewed 2026-11-06 — recorded in README
// "Source terms". We never redistribute the raw list; we return only the hits
// that match the business asked about, with provenance back to OFAC.
//
//   SDN.CSV  ent_num, SDN_Name, SDN_Type, Program, Title, ...  (primary names)
//   ALT.CSV  ent_num, alt_num, alt_type(aka/fka/nka), alt_name, remarks
// Join key is ent_num. We screen against primary names AND aliases so a match on
// a known aka ("NATIONAL BANK OF CUBA" -> BANCO NACIONAL DE CUBA) is not missed.

const { scoreCandidate, normalizeLoose, normalizeCore, diceBigram } = require('./match');

// OFAC keyless export endpoints (302 -> presigned S3; fetch must follow redirects).
const SDN_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV';
const ALT_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV';
// Human-verifiable provenance: OFAC's own Sanctions List Search, deep-linked by name.
const OFAC_SEARCH = 'https://sanctionssearch.ofac.treas.gov/';

const SENTINEL = '-0-'; // OFAC's empty-field marker.

// Screening uses a LOWER accept bar than entity verification on purpose: in
// sanctions compliance a false negative (missing a real hit) is far costlier
// than a false positive (a review item). Below this we report `clear`.
const DEFAULT_SANCTIONS_MIN = 0.85;
const FUZZY_FLOOR = 0.78;            // keep fuzzy hits at/above this as review items
const MATCH_FLOOR = 0.97;            // exact/normalized -> hard `match`
const MAX_FUZZY_CANDIDATES = 4000;   // bound per-name fuzzy scan (names are distinctive)
const CONTAINMENT_CONF = 0.9;        // full token-containment on a distinctive token -> potential_match
const TOKEN_SIM = 0.82;              // two tokens "the same" above this bigram similarity
// Specificity gates, derived from the list's own token inverse-document-frequency
// (IDF = ln(N/df)) — NOT a hardcoded stopword list. A shared token is distinctive
// when it is rare in the corpus: "gazprom"/"sberbank"/"neft" clear these; generic
// corporate words ("bank","company","trading","national") fall below both, so a
// substring like "National Bank" never flags while "Gazprom Neft" does.
const IDF_STRONG = 6.2;              // one shared token this specific -> enough on its own
const IDF_SUM = 11.0;               // or the shared tokens' total specificity mass

function tokenIdf(index, t) {
  const n = index.size || 1;
  const df = (index.token.get(t) || []).length;
  return df > 0 ? Math.log(n / df) : 0; // token absent from the list carries no signal
}

// Do the IDF specificity of `phrase` tokens clear the distinctiveness gate?
function phraseDistinctive(phrase, index) {
  let maxIdf = 0;
  let sumIdf = 0;
  for (const t of phrase) {
    if (t.length < 4) continue;
    const idf = tokenIdf(index, t);
    if (idf > maxIdf) maxIdf = idf;
    sumIdf += idf;
  }
  return { distinctive: maxIdf >= IDF_STRONG || sumIdf >= IDF_SUM, maxIdf, sumIdf };
}

// Is `needle` a CONTIGUOUS token subsequence of `hay` (tokens equal or near via
// bigram similarity)? Contiguity is what separates a real embedded name
// ("gazprom neft" inside "...company gazprom neft") from a scattered token
// coincidence ("global ... logistics" with an unrelated word in between).
function contiguousIn(needle, hay) {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let all = true;
    for (let j = 0; j < needle.length; j++) {
      const a = needle[j];
      const b = hay[i + j];
      if (a !== b && diceBigram(a, b) < TOKEN_SIM) { all = false; break; }
    }
    if (all) return true;
  }
  return false;
}

// Containment signal between two legal-suffix-stripped cores. Fires only on a
// CONTIGUOUS, IDF-distinctive phrase match, so a verified business whose name is
// embedded in a longer sanctioned name (or that embeds a multi-word sanctioned
// name) is surfaced for review, without flagging generic substrings or a single
// common word that happens to collide with a vessel/alias.
function containment(queryCore, candCore, index) {
  const q = queryCore.split(' ').filter(Boolean);
  const c = candCore.split(' ').filter(Boolean);
  if (!q.length || !c.length) return { contained: false };

  // Single-word query: flag only when the WHOLE query is one distinctive word
  // present in the candidate (e.g. "Sberbank"). A lone matching token inside a
  // multi-word query never triggers — that is the vessel/alias-collision trap.
  if (q.length === 1) {
    if (!contiguousIn(q, c)) return { contained: false };
    const d = phraseDistinctive(q, index);
    return { contained: d.distinctive && d.maxIdf >= IDF_STRONG, ...d };
  }

  // Multi-word: query embedded in candidate, OR a >=2-word candidate name
  // embedded in the query. Gate the matched phrase on IDF specificity.
  if (contiguousIn(q, c)) {
    const d = phraseDistinctive(q, index);
    if (d.distinctive) return { contained: true, direction: 'query_in_listed', ...d };
  }
  if (c.length >= 2 && contiguousIn(c, q)) {
    const d = phraseDistinctive(c, index);
    if (d.distinctive) return { contained: true, direction: 'listed_in_query', ...d };
  }
  return { contained: false };
}

// --- tiny RFC-4180-ish CSV parser (quoted fields may contain commas) ---------
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function cleanField(v) {
  const s = String(v == null ? '' : v).trim();
  return s === SENTINEL || s === '' ? null : s;
}

// Parse the bracketed/space-joined OFAC program string into clean program codes.
function parsePrograms(raw) {
  const s = cleanField(raw);
  if (!s) return [];
  const seen = new Set();
  for (const tok of s.split(/[[\]\s]+/)) {
    const t = tok.trim();
    if (t && t !== SENTINEL) seen.add(t);
  }
  return [...seen];
}

// --- list parsing ------------------------------------------------------------

// Parse SDN.CSV text -> array of primary entries.
function parseSdn(text) {
  const entries = [];
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const c = parseCsvLine(line);
    if (c.length < 3) continue;
    const entNum = cleanField(c[0]);
    const name = cleanField(c[1]);
    if (!entNum || !name) continue;
    entries.push({
      ent_num: entNum,
      name,
      sdn_type: (cleanField(c[2]) || 'entity').toLowerCase(), // '-0-' -> entity
      programs: parsePrograms(c[3]),
      title: cleanField(c[4]),
      list: 'SDN',
      via: 'primary',
    });
  }
  return entries;
}

// Parse ALT.CSV text -> array of alias entries keyed to ent_num.
function parseAlt(text) {
  const aliases = [];
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const c = parseCsvLine(line);
    if (c.length < 4) continue;
    const entNum = cleanField(c[0]);
    const name = cleanField(c[3]);
    if (!entNum || !name) continue;
    aliases.push({
      ent_num: entNum,
      name,
      alt_type: (cleanField(c[2]) || 'aka').toLowerCase(),
      via: 'alias',
    });
  }
  return aliases;
}

// --- screening index ---------------------------------------------------------
// Built once per run (or injected pre-built) and reused for every input row.
// exact/core Maps give O(1) definitive-tier hits; a token inverted index bounds
// the fuzzy candidate set so a 40k-name list screens fast even on big batches.

function buildIndex(primaries, aliases = []) {
  const byEnt = new Map();
  for (const p of primaries) byEnt.set(p.ent_num, p);

  // A screenable "name node" carries its display name + a pointer to the SDN
  // entry it belongs to + how it was reached (primary vs a specific alias type).
  const nodes = [];
  for (const p of primaries) {
    nodes.push({ name: p.name, ent: p, via: 'primary', alt_type: null });
  }
  for (const a of aliases) {
    const ent = byEnt.get(a.ent_num);
    if (!ent) continue; // alias without a known primary; skip (never fabricate)
    nodes.push({ name: a.name, ent, via: 'alias', alt_type: a.alt_type });
  }

  const exact = new Map();  // normalizeLoose -> [nodeIdx]
  const core = new Map();   // normalizeCore  -> [nodeIdx]
  const token = new Map();  // core token     -> [nodeIdx]
  nodes.forEach((node, idx) => {
    const lo = normalizeLoose(node.name);
    const co = normalizeCore(node.name);
    if (lo) { if (!exact.has(lo)) exact.set(lo, []); exact.get(lo).push(idx); }
    if (co) { if (!core.has(co)) core.set(co, []); core.get(co).push(idx); }
    for (const t of new Set(co.split(' ').filter(Boolean))) {
      if (!token.has(t)) token.set(t, []);
      token.get(t).push(idx);
    }
  });
  return { nodes, exact, core, token, size: nodes.length };
}

function ofacSourceUrl(entNum) {
  // Deep-link to OFAC's own Sanctions List Search; ID is the stable ent_num.
  return `${OFAC_SEARCH}?id=${encodeURIComponent(entNum)}`;
}

function hitFromNode(node, confidence, tier) {
  return {
    sdn_name: node.ent.name,
    matched_name: node.name,
    ent_num: node.ent.ent_num,
    sdn_type: node.ent.sdn_type,
    list: node.ent.list || 'SDN',
    programs: node.ent.programs || [],
    title: node.ent.title || null,
    matched_via: node.via,
    alias_type: node.alt_type || null,
    match_confidence: Math.round(confidence * 100) / 100,
    match_tier: tier,
    source_url: ofacSourceUrl(node.ent.ent_num),
  };
}

// Screen ONE name against a pre-built index. Returns deduped hits (best per
// ent_num), sorted strongest-first, each at/above the fuzzy floor.
function screenName(name, index, minConfidence = DEFAULT_SANCTIONS_MIN) {
  const core = String(name || '').trim();
  if (!core || !index || !index.size) return [];
  const bestByEnt = new Map(); // ent_num -> { conf, tier, nodeIdx }
  const consider = (idx, conf, tier) => {
    const node = index.nodes[idx];
    const key = node.ent.ent_num;
    const prev = bestByEnt.get(key);
    if (!prev || conf > prev.conf) bestByEnt.set(key, { conf, tier, nodeIdx: idx });
  };

  // 1. definitive tiers via O(1) maps (exact / normalized / core)
  const lo = normalizeLoose(core);
  const co = normalizeCore(core);
  for (const idx of index.exact.get(lo) || []) {
    const s = scoreCandidate(core, index.nodes[idx].name);
    consider(idx, s.confidence, s.tier);
  }
  for (const idx of index.core.get(co) || []) {
    if (!bestByEnt.has(index.nodes[idx].ent.ent_num)) consider(idx, 0.9, 'core');
  }

  // 2. fuzzy: only nodes that share a core token with the query (bounded)
  const candidateIdx = new Set();
  for (const t of new Set(co.split(' ').filter(Boolean))) {
    const posting = index.token.get(t);
    if (!posting) continue;
    for (const idx of posting) {
      candidateIdx.add(idx);
      if (candidateIdx.size >= MAX_FUZZY_CANDIDATES) break;
    }
    if (candidateIdx.size >= MAX_FUZZY_CANDIDATES) break;
  }
  for (const idx of candidateIdx) {
    const ent = index.nodes[idx].ent.ent_num;
    const prev = bestByEnt.get(ent);
    if (prev && prev.conf >= MATCH_FLOOR) continue; // already definitive
    const s = scoreCandidate(core, index.nodes[idx].name);
    if (s.confidence >= FUZZY_FLOOR) { consider(idx, s.confidence, s.tier); continue; }
    // Containment: a distinctive query name wholly inside a longer listed name
    // (extra corporate words) -> surface as a review item, never auto-confirmed.
    if (s.confidence < CONTAINMENT_CONF) {
      const c = containment(co, normalizeCore(index.nodes[idx].name), index);
      if (c.contained) consider(idx, CONTAINMENT_CONF, 'contained');
    }
  }

  const hits = [];
  for (const { conf, tier, nodeIdx } of bestByEnt.values()) {
    if (conf >= FUZZY_FLOOR && conf >= Math.min(minConfidence, FUZZY_FLOOR)) {
      hits.push(hitFromNode(index.nodes[nodeIdx], conf, tier));
    }
  }
  hits.sort((a, b) => b.match_confidence - a.match_confidence);
  return hits;
}

function verdictFor(hits, minConfidence) {
  if (!hits.length) return 'clear';
  const top = hits[0].match_confidence;
  if (top >= MATCH_FLOOR) return 'match';
  if (top >= minConfidence) return 'potential_match';
  return 'clear';
}

// --- live loader (cached per process) ----------------------------------------
let _cache = null; // { index, loadedAt, counts }

async function fetchText(url, { fetchImpl, timeoutMs = 30000 } = {}) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new Error('no fetch implementation available');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, {
      redirect: 'follow', // 302 -> presigned S3
      headers: { 'User-Agent': 'us-business-verification/0.4 (+apify actor)', Accept: 'text/csv,*/*' },
      signal: ctrl.signal,
    });
    if (!res.ok) { const e = new Error(`OFAC HTTP ${res.status}`); e.status = res.status; throw e; }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Load + index the OFAC lists once per process. `opts.fetchImpl` is injectable
// for tests; `opts.force` bypasses the cache.
async function loadOfacIndex(opts = {}) {
  if (_cache && !opts.force) return _cache;
  const [sdnText, altText] = await Promise.all([
    fetchText(SDN_URL, opts),
    fetchText(ALT_URL, opts).catch(() => ''), // aliases are enrichment; degrade open
  ]);
  const primaries = parseSdn(sdnText);
  const aliases = altText ? parseAlt(altText) : [];
  if (!primaries.length) throw new Error('OFAC SDN parse yielded 0 entries');
  const index = buildIndex(primaries, aliases);
  _cache = {
    index,
    loadedAt: new Date().toISOString(),
    counts: { primaries: primaries.length, aliases: aliases.length, nodes: index.size },
  };
  return _cache;
}

function emptyScreen(extra = {}) {
  return {
    checked: true,
    list: 'OFAC_SDN',
    screened_names: [],
    verdict: 'clear',
    hit_count: 0,
    top_confidence: 0,
    hits: [],
    source_url: OFAC_SEARCH,
    retrieved_at: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Screen a verified business (and optional registered agent) against OFAC.
 * Returns a `sanctions` block. Degrades OPEN on any upstream failure (never
 * throws, never fabricates a hit). `opts.index` lets the caller pass a
 * pre-loaded index (built once per batch); otherwise it is loaded + cached.
 */
async function screenSanctions(businessName, opts = {}) {
  const minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : DEFAULT_SANCTIONS_MIN;
  const retrievedAt = new Date().toISOString();
  const names = [];
  const primary = String(businessName || '').trim();
  if (primary) names.push(primary);
  if (opts.registeredAgent && String(opts.registeredAgent).trim()) {
    const ra = String(opts.registeredAgent).trim();
    if (ra.toLowerCase() !== primary.toLowerCase()) names.push(ra);
  }
  if (!names.length) return emptyScreen({ retrieved_at: retrievedAt });

  let index = opts.index;
  if (!index) {
    try {
      const loaded = await loadOfacIndex(opts);
      index = loaded.index;
    } catch (e) {
      return emptyScreen({ retrieved_at: retrievedAt, error: 'ofac_load_failed', verdict: 'unknown' });
    }
  }

  const byEnt = new Map();
  const screenedWith = [];
  for (const nm of names) {
    const hits = screenName(nm, index, minConfidence);
    if (hits.length) screenedWith.push(nm);
    for (const h of hits) {
      const prev = byEnt.get(h.ent_num);
      if (!prev || h.match_confidence > prev.match_confidence) {
        byEnt.set(h.ent_num, { ...h, screened_name: nm });
      }
    }
  }
  const hits = [...byEnt.values()].sort((a, b) => b.match_confidence - a.match_confidence);
  const verdict = verdictFor(hits, minConfidence);

  return {
    checked: true,
    list: 'OFAC_SDN',
    screened_names: names,
    verdict, // clear | potential_match | match
    hit_count: hits.length,
    top_confidence: hits.length ? hits[0].match_confidence : 0,
    hits,
    source_url: OFAC_SEARCH,
    retrieved_at: retrievedAt,
  };
}

module.exports = {
  screenSanctions, loadOfacIndex, buildIndex, screenName, verdictFor,
  parseSdn, parseAlt, parseCsvLine, parsePrograms, ofacSourceUrl,
  SDN_URL, ALT_URL, OFAC_SEARCH, DEFAULT_SANCTIONS_MIN, MATCH_FLOOR, FUZZY_FLOOR,
};
