'use strict';

// Unified cross-state record schema + status normalization.
// Every state adapter maps its raw row into this one shape so a buyer gets an
// identical record regardless of which state answered.

// Map the heterogeneous state status strings into a small canonical vocabulary.
// Returns one of: active | inactive | unknown  (+ the verbatim raw status kept).
function normalizeStatus(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return 'unknown';
  const active = [
    'active', 'good standing', 'current-active', 'current active',
    'exists', 'in existence', 'registered', 'valid', 'current',
  ];
  const inactive = [
    'dissolved', 'revoked', 'delinquent', 'inactive', 'cancelled', 'canceled',
    'expired', 'terminated', 'withdrawn', 'merged', 'suspended', 'forfeited',
    'administratively dissolved', 'voluntarily dissolved', 'noncompliant',
    'defunct', 'surrendered',
  ];
  for (const a of active) if (s === a) return 'active';
  for (const i of inactive) if (s.includes(i)) return 'inactive';
  for (const a of active) if (s.includes(a)) return 'active';
  return 'unknown';
}

// Normalize a date-ish value into ISO YYYY-MM-DD (or null).
function toISODate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Recently-formed qualifier. Cobalt's KYB rubric: the 2-5% false-no-match band
// concentrates on entities formed < 12 months (state propagation lag "routinely
// exceeds a week, can exceed a month"). We expose this as a first-class signal so
// a buyer can down-weight a clean no-match on a brand-new entity instead of
// treating "not found yet" as "not registered".
// Returns true (< windowDays old), false (older), or null (no/garbage date or
// a future date, which is almost always a bad upstream value).
const RECENT_WINDOW_DAYS = 365;
function recentlyFormed(formationDate, asOf, windowDays = RECENT_WINDOW_DAYS) {
  if (!formationDate) return null;
  const d = new Date(formationDate);
  if (isNaN(d.getTime())) return null;
  const ref = asOf ? new Date(asOf) : new Date();
  if (isNaN(ref.getTime())) return null;
  const ageDays = (ref.getTime() - d.getTime()) / 86400000;
  if (ageDays < 0) return null; // future formation date => untrustworthy
  return ageDays <= windowDays;
}

// Classify WHY a verification did not produce a billable match. The axis the
// incumbents elide: a buyer must be able to tell "not registered" from
// "registered-but-not-yet-propagated / mis-typed / wrong state". Values:
//   no_source_for_state  no adapter was available for the requested state
//   source_error         every queried source errored (transient / upstream down)
//   not_found            sources answered cleanly but returned ZERO candidate rows
//   no_match             candidates were returned, none met the confidence bar
function deriveNoMatchReason({ triedCount, erroredCount, rowsReturned, candidateCount }) {
  if (!triedCount) return 'no_source_for_state';
  if (erroredCount >= triedCount && !rowsReturned) return 'source_error';
  if (!rowsReturned && !candidateCount) return 'not_found';
  return 'no_match';
}

// Build the unified verification record. `raw` is the already-adapter-mapped
// subset; this function only pins the canonical shape + derived fields.
function buildRecord({
  inputName, inputState, matched, confidence, tier,
  entityName, entityId, statusRaw, entityType, formationDate,
  jurisdiction, registeredAgent, principalAddress,
  sourceState, sourceUrl, retrievedAt,
}) {
  return {
    input_name: inputName,
    input_state: inputState || null,
    matched: !!matched,
    match_confidence: typeof confidence === 'number' ? Math.round(confidence * 100) / 100 : 0,
    match_tier: tier || 'none',
    entity_name: entityName || null,
    entity_id: entityId || null,
    status: statusRaw || null,
    status_normalized: normalizeStatus(statusRaw),
    entity_type: entityType || null,
    formation_date: toISODate(formationDate),
    recently_formed: recentlyFormed(formationDate, retrievedAt),
    jurisdiction: jurisdiction || null,
    registered_agent: registeredAgent || null,
    principal_address: principalAddress || null,
    source_state: sourceState || null,
    source_url: sourceUrl || null,
    retrieved_at: retrievedAt || new Date().toISOString(),
  };
}

// A no-match record (still returned so the buyer sees the negative, never billed).
// This is a DEFENSIBLE AUDIT RECORD, not a bare "false": a KYB/credit team can
// show a regulator exactly what was searched, which near-misses were considered,
// why none qualified, and whether the gap looks like a true negative or a
// propagation-lag false negative. `audit` carries:
//   no_match_reason   not_found | no_match | source_error | no_source_for_state
//   candidates[]      the raw ranked candidate set actually considered
//   query_strategy    retrieval passes + the name variations compared
//   recently_formed_candidate  true if any near-miss is < 12mo old (lag band)
function noMatchRecord({ inputName, inputState, triedStates, retrievedAt, audit }) {
  const a = audit || {};
  const candidates = Array.isArray(a.candidates) ? a.candidates : [];
  const reason = a.no_match_reason || deriveNoMatchReason({
    triedCount: (triedStates || []).length,
    erroredCount: a.erroredCount || 0,
    rowsReturned: !!a.rowsReturned,
    candidateCount: candidates.length,
  });
  const recentlyFormedCandidate = candidates.some((c) => c && c.recently_formed === true);
  return {
    input_name: inputName,
    input_state: inputState || null,
    matched: false,
    match_confidence: 0,
    match_tier: 'none',
    entity_name: null,
    entity_id: null,
    status: null,
    status_normalized: 'unknown',
    entity_type: null,
    formation_date: null,
    recently_formed: null,
    jurisdiction: null,
    registered_agent: null,
    principal_address: null,
    source_state: null,
    source_url: null,
    tried_states: triedStates || [],
    // Defensible no-match audit (the axis incumbents elide).
    no_match_reason: reason,
    candidates_considered: candidates.length,
    candidates,
    query_strategy: a.query_strategy || null,
    recently_formed_candidate: recentlyFormedCandidate,
    retrieved_at: retrievedAt || new Date().toISOString(),
  };
}

module.exports = {
  normalizeStatus, toISODate, recentlyFormed, deriveNoMatchReason,
  buildRecord, noMatchRecord,
};
