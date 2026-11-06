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

  return rec;
}

module.exports = { verifyOne, DEFAULT_MIN_CONFIDENCE };
