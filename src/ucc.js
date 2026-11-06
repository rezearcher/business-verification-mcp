'use strict';

// Colorado UCC lien lane — buyer-ladder STEP 2 (lien discovery), the depth axis
// the entity-only incumbents don't resolve. Given a business (debtor) name, this
// resolves its UCC financing statements: how many, how many still ACTIVE vs
// lapsed/terminated, the filing dates, and the secured parties (lenders) — each
// with the exact source URL, retrieved live. A credit/KYB team reads this to see
// whether a counterparty's assets are already pledged before extending terms.
//
// Source: three keyless datasets on data.colorado.gov (Socrata), all license
// "Public Domain" (CDOS), reviewed 2026-11-05 — see README "Source terms":
//   debtor       8upq-58vz  (organizationname -> fileid, recordstatus)
//   filing       wffy-3uut  (fileid -> filingdate, filingtype, lapsedate, termination)
//   securedparty ap62-sav4  (fileid -> the lender)
// Join key is `fileid`. Debtor names are matched to the queried business with the
// same confidence scorer used for entity verification, so a lien only attaches
// when the debtor really is the business asked about (never a fuzzy stranger).

const { sodaGet, soqlQuote } = require('./sources/socrata');
const { scoreCandidate } = require('./match');

const HOST = 'https://data.colorado.gov/resource';
const DEBTOR = `${HOST}/8upq-58vz.json`;
const FILING = `${HOST}/wffy-3uut.json`;
const SECURED = `${HOST}/ap62-sav4.json`;

// Bounds (keep per-match compute small + predictable).
const MAX_DEBTOR_ROWS = 60;
const MAX_FILE_IDS = 100; // cap liens examined per business
const CHUNK = 50; // Socrata in() list size per request

function inList(ids) {
  return ids.map((i) => `'${soqlQuote(String(i))}'`).join(',');
}

function toISO(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function securedPartyName(r) {
  if (r.organizationname) return r.organizationname;
  const n = [r.firstname, r.lastname].filter(Boolean).join(' ').trim();
  return n || null;
}

// Fetch debtor rows whose organizationname matches `name` (exact pass, then a
// full-text recall pass if the exact pass was thin). Caller scores + filters.
async function fetchDebtors(name, opts) {
  const core = String(name).trim();
  const out = [];
  const seen = new Set();
  const push = (rows) => {
    for (const r of rows || []) {
      const key = r.debtorid || JSON.stringify(r);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  };
  try {
    const exact = await sodaGet(DEBTOR, {
      $where: `upper(organizationname)=upper('${soqlQuote(core)}')`,
      $limit: String(MAX_DEBTOR_ROWS),
    }, opts);
    push(exact);
  } catch (_) { /* fall through */ }
  if (out.length < 5) {
    try {
      const ft = await sodaGet(DEBTOR, { $q: core, $limit: String(MAX_DEBTOR_ROWS) }, opts);
      push(ft);
    } catch (_) { /* keep exact */ }
  }
  return out.slice(0, MAX_DEBTOR_ROWS);
}

// Batch-fetch rows from a dataset for a set of fileids (chunked in() queries).
async function fetchByFileIds(baseUrl, fileIds, opts) {
  const rows = [];
  for (let i = 0; i < fileIds.length; i += CHUNK) {
    const chunk = fileIds.slice(i, i + CHUNK);
    try {
      const got = await sodaGet(baseUrl, {
        $where: `fileid in (${inList(chunk)})`,
        $limit: '1000',
      }, opts);
      for (const r of got || []) rows.push(r);
    } catch (_) { /* degrade open: skip this chunk */ }
  }
  return rows;
}

function emptyResult(extra = {}) {
  return {
    checked: true,
    jurisdiction: 'CO',
    matched_debtor: false,
    debtor_confidence: 0,
    lien_count: 0,
    active_lien_count: 0,
    has_active_liens: false,
    secured_parties: [],
    earliest_filing_date: null,
    latest_filing_date: null,
    liens: [],
    source_url: null,
    retrieved_at: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Resolve the UCC lien profile for one business name against Colorado's public
 * UCC datasets. `opts.minConfidence` (default 0.85) is the debtor-name match
 * threshold. Returns a `ucc` block. Degrades open on any upstream failure
 * (never throws, never fabricates a lien).
 */
async function searchUccLiens(name, opts = {}) {
  const minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : 0.85;
  const retrievedAt = new Date().toISOString();
  const core = String(name || '').trim();
  if (!core) return emptyResult({ retrieved_at: retrievedAt });

  const debtors = await fetchDebtors(core, opts);

  // Keep only debtor rows whose org name matches the queried business with
  // confidence (so a lien attaches to the RIGHT entity, scored + falsifiable).
  const matched = [];
  for (const d of debtors) {
    const s = scoreCandidate(core, d.organizationname);
    if (s.confidence >= minConfidence) matched.push({ row: d, confidence: s.confidence });
  }
  if (!matched.length) {
    const srcUrl = `${DEBTOR}?$where=${encodeURIComponent(`upper(organizationname)=upper('${soqlQuote(core)}')`)}`;
    return emptyResult({ retrieved_at: retrievedAt, source_url: srcUrl });
  }

  const bestDebtorConfidence = matched.reduce((m, x) => Math.max(m, x.confidence), 0);

  // Map fileid -> debtor recordstatus (whether this debtor entry is live on the filing).
  const debtorStatusByFile = new Map();
  for (const { row } of matched) {
    if (!row.fileid) continue;
    const prev = debtorStatusByFile.get(row.fileid);
    // an active debtor entry wins over a non-active one for the same filing
    if (prev !== 'active') debtorStatusByFile.set(row.fileid, (row.recordstatus || '').toLowerCase() || prev || null);
  }

  let fileIds = [...debtorStatusByFile.keys()];
  const truncated = fileIds.length > MAX_FILE_IDS;
  fileIds = fileIds.slice(0, MAX_FILE_IDS);

  const [filingRows, securedRows] = await Promise.all([
    fetchByFileIds(FILING, fileIds, opts),
    fetchByFileIds(SECURED, fileIds, opts),
  ]);

  // Index filings (take the INITIAL filing per fileid as the primary; keep lapse/termination).
  const filingByFile = new Map();
  for (const r of filingRows) {
    const fid = r.fileid;
    if (!fid) continue;
    const cur = filingByFile.get(fid);
    const isInitial = String(r.transactiontype || '').toLowerCase().includes('initial');
    // terminationflag / lapsedate from ANY transaction on the file reflect the file's live state.
    const merged = cur || { fileid: fid };
    if (!cur || isInitial) {
      merged.filingdate = r.filingdate || merged.filingdate;
      merged.filingtype = r.filingtype || merged.filingtype;
      merged.documenttype = r.documenttype || merged.documenttype;
      merged.lapsedate = r.lapsedate || merged.lapsedate;
    }
    if (r.terminationflag === true || r.terminationflag === 'true') merged.terminated = true;
    if (r.lapsedate && (!merged.lapsedate || new Date(r.lapsedate) > new Date(merged.lapsedate))) merged.lapsedate = r.lapsedate;
    filingByFile.set(fid, merged);
  }

  // Index secured parties by fileid (unique lender names).
  const securedByFile = new Map();
  for (const r of securedRows) {
    const fid = r.fileid;
    if (!fid) continue;
    const nm = securedPartyName(r);
    if (!nm) continue;
    if (!securedByFile.has(fid)) securedByFile.set(fid, new Set());
    securedByFile.get(fid).add(nm);
  }

  const now = Date.now();
  const liens = [];
  const allSecured = new Set();
  let active = 0;
  let earliest = null;
  let latest = null;

  for (const fid of fileIds) {
    const f = filingByFile.get(fid) || { fileid: fid };
    const debtorStatus = debtorStatusByFile.get(fid) || null;
    const parties = [...(securedByFile.get(fid) || [])];
    parties.forEach((p) => allSecured.add(p));

    const lapse = f.lapsedate ? new Date(f.lapsedate).getTime() : null;
    const lapsed = lapse !== null && lapse < now;
    const terminated = f.terminated === true;
    // Active = debtor entry active on the file, not terminated, not past its lapse date.
    const isActive = debtorStatus === 'active' && !terminated && !lapsed;
    if (isActive) active++;

    let status = 'active';
    if (terminated) status = 'terminated';
    else if (lapsed) status = 'lapsed';
    else if (debtorStatus && debtorStatus !== 'active') status = debtorStatus;

    const filingISO = toISO(f.filingdate);
    if (filingISO) {
      if (!earliest || filingISO < earliest) earliest = filingISO;
      if (!latest || filingISO > latest) latest = filingISO;
    }

    liens.push({
      file_id: fid,
      filing_date: filingISO,
      filing_type: f.filingtype || null,
      document_type: f.documenttype || null,
      lapse_date: toISO(f.lapsedate),
      status,
      terminated,
      lapsed,
      secured_parties: parties,
      source_url: `${FILING}?$where=${encodeURIComponent(`fileid='${fid}'`)}`,
    });
  }

  // Newest filings first.
  liens.sort((a, b) => (b.filing_date || '').localeCompare(a.filing_date || ''));

  const debtorSourceUrl = `${DEBTOR}?$where=${encodeURIComponent(`upper(organizationname)=upper('${soqlQuote(core)}')`)}`;

  return {
    checked: true,
    jurisdiction: 'CO',
    matched_debtor: true,
    debtor_confidence: Math.round(bestDebtorConfidence * 100) / 100,
    lien_count: liens.length,
    active_lien_count: active,
    has_active_liens: active > 0,
    secured_parties: [...allSecured],
    earliest_filing_date: earliest,
    latest_filing_date: latest,
    liens,
    truncated,
    source_url: debtorSourceUrl,
    retrieved_at: retrievedAt,
  };
}

module.exports = { searchUccLiens, fetchDebtors, fetchByFileIds, securedPartyName, DEBTOR, FILING, SECURED };
