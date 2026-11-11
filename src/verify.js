'use strict';

// Orchestrator: for each input row, query the relevant state source(s), score
// every candidate with match.js, keep the best, and build a unified record.
// Billing is the caller's responsibility (billed only when matched === true).

const { getSource, listStates } = require('./sources');
const { scoreCandidate, normalizeLoose, normalizeCore } = require('./match');
const { buildRecord, noMatchRecord, recentlyFormed, deriveNoMatchReason } = require('./normalize');

// Cap the candidate audit set so a no-match record stays bounded on wide full-text hits.
const MAX_AUDIT_CANDIDATES = 8;
const { searchUccLiens } = require('./ucc');
const { screenSanctions } = require('./sanctions');
const { screenFields } = require('./field_safety');

// States with a keyless public UCC-lien lane wired in (buyer-ladder step 2).
const UCC_STATES = new Set(['CO']);

const DEFAULT_MIN_CONFIDENCE = 0.85;

// Verify one { name, state? } row. Returns a single unified record.
async function verifyOne(row, cfg = {}) {
  const inputName = String(row.name || row.entity_name || '').trim();
  const inputState = row.state ? String(row.state).toUpperCase() : null;
  const minConfidence = typeof cfg.minConfidence === 'number' ? cfg.minConfidence : DEFAULT_MIN_CONFIDENCE;
  const retrievedAt = new Date().toISOString();

  if (!inputName) {
    return { ...noMatchRecord({ inputName: inputName, inputState, triedStates: [], retrievedAt }), error: 'empty_name' };
  }

  // Which states to query: the row's explicit state, else the configured set,
  // else every registered state.
  let states;
  if (inputState) states = [inputState];
  else if (Array.isArray(cfg.states) && cfg.states.length) states = cfg.states.map((s) => s.toUpperCase());
  else states = listStates();

  const triedStates = [];
  let overallBest = null; // { mapped, confidence, tier, source }
  const scored = []; // every candidate considered, for the no-match audit trail
  let rowsReturned = false; // did ANY source return >=1 candidate row?
  let erroredCount = 0;

  for (const st of states) {
    const src = getSource(st);
    if (!src) continue;
    triedStates.push(st);
    let candidates;
    try {
      candidates = await src.search(inputName, {
        fetchImpl: cfg.fetchImpl,
        timeoutMs: cfg.timeoutMs,
        appToken: cfg.appToken,
        limit: cfg.candidateLimit,
      });
    } catch (e) {
      // Source-level failure degrades OPEN: record the attempt, never fabricate.
      triedStates[triedStates.length - 1] = `${st}(error)`;
      erroredCount += 1;
      continue;
    }
    if (!candidates || !candidates.length) continue;
    rowsReturned = true;

    // Score every candidate's _name; keep the single best across all states AND
    // retain the full ranked set for the defensible no-match audit record.
    for (const cand of candidates) {
      const s = scoreCandidate(inputName, cand._name);
      scored.push({
        entity_name: cand.entityName || cand._name || null,
        source_state: src.state,
        confidence: Math.round(s.confidence * 100) / 100,
        tier: s.tier,
        status: cand.statusRaw || null,
        formation_date: cand.formationDate ? new Date(cand.formationDate).toISOString().slice(0, 10) : null,
        recently_formed: recentlyFormed(cand.formationDate, retrievedAt),
        source_url: cand.sourceUrl || null,
      });
      if (!overallBest || s.confidence > overallBest.confidence) {
        overallBest = { mapped: cand, confidence: s.confidence, tier: s.tier, source: src };
      }
      if (s.confidence >= 1.0) break;
    }
    // Early exit on a perfect match in a specific requested state.
    if (overallBest && overallBest.confidence >= 1.0) break;
  }

  if (!overallBest || overallBest.confidence < minConfidence) {
    // Defensible no-match: hand the buyer the full audit trail (reason, ranked
    // near-misses, the name variations compared) so they can tell a true negative
    // from a propagation-lag false negative. matched=false => NOT billed.
    const candidates = scored
      .filter((c) => c.confidence > 0)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_AUDIT_CANDIDATES);
    const nameVariations = [...new Set([inputName, normalizeLoose(inputName), normalizeCore(inputName)].filter(Boolean))];
    const audit = {
      no_match_reason: deriveNoMatchReason({
        triedCount: triedStates.length,
        erroredCount,
        rowsReturned,
        candidateCount: candidates.length,
      }),
      candidates,
      rowsReturned,
      erroredCount,
      query_strategy: {
        retrieval: 'exact_name_match_then_fulltext',
        name_variations_compared: nameVariations,
        min_confidence: minConfidence,
      },
    };
    const rec = noMatchRecord({ inputName, inputState, triedStates, retrievedAt, audit });
    if (overallBest && overallBest.confidence > 0) {
      rec.best_candidate = overallBest.mapped.entityName;
      rec.best_candidate_confidence = Math.round(overallBest.confidence * 100) / 100;
      rec.best_candidate_tier = overallBest.tier;
      rec.best_candidate_state = overallBest.source.state;
    }
    // Screen every registry-sourced free-text field (incl. candidate names in
    // the no-match audit) for indirect prompt injection / tool poisoning before
    // the buyer's agent ingests the record. Flag-only; never mutates data.
    rec.field_safety = screenFields(rec);
    return rec;
  }

  const m = overallBest.mapped;
  const rec = buildRecord({
    inputName,
    inputState,
    matched: true,
    confidence: overallBest.confidence,
    tier: overallBest.tier,
    entityName: m.entityName,
    entityId: m.entityId,
    statusRaw: m.statusRaw,
    entityType: m.entityType,
    formationDate: m.formationDate,
    jurisdiction: m.jurisdiction,
    registeredAgent: m.registeredAgent,
    principalAddress: m.principalAddress,
    sourceState: overallBest.source.state,
    sourceUrl: m.sourceUrl,
    retrievedAt,
  });
  rec.tried_states = triedStates;

  // Depth: UCC-lien resolution (buyer-ladder step 2). Enrich a verified match
  // with its public UCC financing-statement profile where the state publishes it
  // keyless. Opt-out via includeUcc:false. Degrades open — never blocks a match.
  if (cfg.includeUcc !== false && UCC_STATES.has(overallBest.source.state)) {
    try {
      rec.ucc = await searchUccLiens(m.entityName || inputName, {
        fetchImpl: cfg.fetchImpl,
        timeoutMs: cfg.timeoutMs,
        appToken: cfg.appToken,
        minConfidence,
      });
    } catch (e) {
      rec.ucc = { checked: true, jurisdiction: overallBest.source.state, error: 'ucc_lookup_failed' };
    }
  }

  // Depth: OFAC sanctions screen (buyer-ladder step 4). Screen the verified
  // business name (and its registered agent) against the OFAC SDN + alias list.
  // Opt-out via includeSanctions:false. The OFAC index is loaded once per batch
  // and passed in via cfg.sanctionsIndex; degrades open — never blocks a match.
  if (cfg.includeSanctions !== false) {
    try {
      rec.sanctions = await screenSanctions(m.entityName || inputName, {
        fetchImpl: cfg.fetchImpl,
        timeoutMs: cfg.timeoutMs,
        index: cfg.sanctionsIndex,
        registeredAgent: m.registeredAgent,
        minConfidence: typeof cfg.sanctionsMinConfidence === 'number' ? cfg.sanctionsMinConfidence : undefined,
      });
    } catch (e) {
      rec.sanctions = { checked: true, list: 'OFAC_SDN', verdict: 'unknown', error: 'sanctions_screen_failed' };
    }
  }

  // Indirect prompt-injection / tool-poisoning screen on the verified record's
  // registry-sourced free-text fields. Flag-only; never mutates data fields.
  rec.field_safety = screenFields(rec);
  return rec;
}

// Authoritative lookup of ONE entity by its registry id within a state. Unlike
// verifyOne this does no fuzzy scoring — the id is a primary key, so a hit is
// the canonical row (confidence 1.0, tier 'exact_id'). Returns a buildRecord-
// shaped record with the same depth enrichment (UCC/OFAC/field_safety) a
// verified match carries. matched=false when the id is unknown or the state is
// unsupported — never fabricated.
async function lookupEntity({ state, entityId }, cfg = {}) {
  const st = String(state || '').toUpperCase();
  const id = String(entityId || '').trim();
  const retrievedAt = new Date().toISOString();
  const src = getSource(st);
  if (!src || typeof src.lookupById !== 'function') {
    return { matched: false, input_entity_id: id, input_state: st || null, error: 'unsupported_state', tried_states: st ? [st] : [], supported_states: listStates(), retrieved_at: retrievedAt };
  }
  if (!id) return { matched: false, input_entity_id: '', input_state: st, error: 'empty_entity_id', retrieved_at: retrievedAt };

  let rows;
  try {
    rows = await src.lookupById(id, { fetchImpl: cfg.fetchImpl, timeoutMs: cfg.timeoutMs, appToken: cfg.appToken });
  } catch (e) {
    // A 400 on an exact-id query means the id can't exist in that typed column
    // (e.g. non-numeric id against a numeric key) — that is a clean "not found",
    // not an outage. Only a true transport/5xx failure is an error.
    if (e && e.status === 400) {
      const rec = { matched: false, input_entity_id: id, input_state: st, no_match_reason: 'id_not_found', note: 'No registry row carries this id in the named state; the id format did not match the registry key. Verify the state and id, or search by name.', tried_states: [st], retrieved_at: retrievedAt };
      rec.field_safety = screenFields(rec);
      return rec;
    }
    return { matched: false, input_entity_id: id, input_state: st, error: e && e.sourceOutage ? 'source_outage' : 'lookup_failed', detail: e && e.message ? e.message : String(e), retrieved_at: retrievedAt };
  }
  if (!rows || !rows.length) {
    const rec = { matched: false, input_entity_id: id, input_state: st, no_match_reason: 'id_not_found', note: 'No registry row carries this id in the named state (verify the state and id, or search by name).', tried_states: [st], retrieved_at: retrievedAt };
    rec.field_safety = screenFields(rec);
    return rec;
  }

  const m = rows[0];
  const rec = buildRecord({
    inputName: m.entityName,
    inputState: st,
    matched: true,
    confidence: 1.0,
    tier: 'exact_id',
    entityName: m.entityName,
    entityId: m.entityId,
    statusRaw: m.statusRaw,
    entityType: m.entityType,
    formationDate: m.formationDate,
    jurisdiction: m.jurisdiction,
    registeredAgent: m.registeredAgent,
    principalAddress: m.principalAddress,
    sourceState: src.state,
    sourceUrl: m.sourceUrl,
    retrievedAt,
  });
  rec.tried_states = [st];
  rec.lookup = 'by_entity_id';

  if (cfg.includeUcc !== false && UCC_STATES.has(src.state)) {
    try { rec.ucc = await searchUccLiens(m.entityName, { fetchImpl: cfg.fetchImpl, timeoutMs: cfg.timeoutMs, appToken: cfg.appToken, minConfidence: DEFAULT_MIN_CONFIDENCE }); }
    catch (_) { rec.ucc = { checked: true, jurisdiction: src.state, error: 'ucc_lookup_failed' }; }
  }
  if (cfg.includeSanctions !== false) {
    try { rec.sanctions = await screenSanctions(m.entityName, { fetchImpl: cfg.fetchImpl, timeoutMs: cfg.timeoutMs, index: cfg.sanctionsIndex, registeredAgent: m.registeredAgent }); }
    catch (_) { rec.sanctions = { checked: true, list: 'OFAC_SDN', verdict: 'unknown', error: 'sanctions_screen_failed' }; }
  }
  rec.field_safety = screenFields(rec);
  return rec;
}

// Enumerate entities within ONE state whose name begins with (then contains) the
// fragment — the "list businesses in this state" surface verifyOne (best-match
// collapse) cannot provide. Returns a bounded, ordered candidate list; each row
// is field_safety-screened. No billing semantics here (the caller meters).
async function enumerateEntities({ state, name, limit }, cfg = {}) {
  const st = String(state || '').toUpperCase();
  const frag = String(name || '').trim();
  const retrievedAt = new Date().toISOString();
  const src = getSource(st);
  if (!src || typeof src.enumerate !== 'function') {
    return { state: st || null, error: 'unsupported_state', supported_states: listStates(), count: 0, results: [], retrieved_at: retrievedAt };
  }
  if (frag.length < 2) {
    return { state: st, error: 'fragment_too_short', note: 'Provide at least 2 characters to enumerate.', count: 0, results: [], retrieved_at: retrievedAt };
  }
  const cap = Math.max(1, Math.min(Number(limit) || 25, 50));
  let rows;
  try {
    rows = await src.enumerate(frag, { fetchImpl: cfg.fetchImpl, timeoutMs: cfg.timeoutMs, appToken: cfg.appToken, limit: cap });
  } catch (e) {
    return { state: st, error: e && e.sourceOutage ? 'source_outage' : 'enumerate_failed', detail: e && e.message ? e.message : String(e), count: 0, results: [], retrieved_at: retrievedAt };
  }
  const results = rows.map((m) => ({
    entity_name: m.entityName || null,
    entity_id: m.entityId || null,
    status: m.statusRaw || null,
    entity_type: m.entityType || null,
    formation_date: m.formationDate ? String(m.formationDate).slice(0, 10) : null,
    jurisdiction: m.jurisdiction || null,
    registered_agent: m.registeredAgent || null,
    source_url: m.sourceUrl || null,
  }));
  const out = { state: st, source: src.label, name_fragment: frag, count: results.length, results, retrieved_at: retrievedAt };
  out.field_safety = screenFields(out);
  return out;
}

module.exports = { verifyOne, lookupEntity, enumerateEntities, DEFAULT_MIN_CONFIDENCE };
