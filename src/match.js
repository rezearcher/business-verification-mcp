'use strict';

// Per-row match confidence scoring — the axis no incumbent advertises.
// We never guess: every returned record carries a 0..1 confidence and a tier
// label so a credit/KYB team can set its own accept threshold.

const LEGAL_SUFFIXES = [
  'incorporated', 'corporation', 'company', 'limited liability company',
  'limited liability partnership', 'limited partnership', 'limited',
  'professional corporation', 'professional limited liability company',
  'inc', 'corp', 'co', 'llc', 'l l c', 'llp', 'lp', 'ltd', 'pc', 'pllc',
  'plc', 'na', 'fsb', 'dba',
];

// Punctuation/whitespace normalization only (case-folded). Keeps the core token stream.
function normalizeLoose(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,/#!$%^*;:{}=\-_`~()'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Loose normalization PLUS trailing legal-suffix removal -> the comparable "core".
function normalizeCore(name) {
  let s = normalizeLoose(name);
  // strip trailing legal suffixes repeatedly (e.g. "google llc" -> "google")
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      const re = new RegExp('(^|\\s)' + suf.replace(/\s/g, '\\s+') + '$');
      if (re.test(s)) {
        s = s.replace(re, '').trim();
        changed = true;
      }
    }
  }
  return s || normalizeLoose(name); // never return empty (one-word legal-suffix names)
}

// Dice coefficient over character bigrams: robust to typos/word order for short names.
function diceBigram(a, b) {
  const grams = (str) => {
    const g = [];
    const t = str.replace(/\s+/g, '');
    for (let i = 0; i < t.length - 1; i++) g.push(t.slice(i, i + 2));
    return g;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.length === 0 && gb.length === 0) return a === b ? 1 : 0;
  if (ga.length === 0 || gb.length === 0) return 0;
  const counts = new Map();
  for (const g of ga) counts.set(g, (counts.get(g) || 0) + 1);
  let inter = 0;
  for (const g of gb) {
    const c = counts.get(g) || 0;
    if (c > 0) { inter++; counts.set(g, c - 1); }
  }
  return (2 * inter) / (ga.length + gb.length);
}

// Token Jaccard on core tokens — handles word reordering / extra words.
function tokenJaccard(a, b) {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Soft token similarity: greedily align tokens, counting a pair as "matched"
// when the two tokens are themselves highly bigram-similar (>= 0.82). This makes
// a single-character typo inside one word ("technlogies" ~ "technologies") count
// as a matched token instead of a total miss, without rewarding unrelated words.
const TOKEN_MATCH_THRESHOLD = 0.82;
function softTokenJaccard(a, b) {
  const ta = a.split(' ').filter(Boolean);
  const tb = b.split(' ').filter(Boolean);
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;
  const usedB = new Array(tb.length).fill(false);
  let matched = 0;
  for (const t of ta) {
    let bestIdx = -1;
    let bestSim = 0;
    for (let j = 0; j < tb.length; j++) {
      if (usedB[j]) continue;
      const sim = t === tb[j] ? 1 : diceBigram(t, tb[j]);
      if (sim > bestSim) { bestSim = sim; bestIdx = j; }
    }
    if (bestIdx >= 0 && bestSim >= TOKEN_MATCH_THRESHOLD) { usedB[bestIdx] = true; matched++; }
  }
  const union = ta.length + tb.length - matched;
  return union === 0 ? 0 : matched / union;
}

/**
 * Score one candidate entity name against the queried input name.
 * Returns { confidence (0..1), tier }.
 *   exact       1.00  identical after case-fold
 *   normalized  0.97  identical after punctuation/whitespace normalization
 *   core        0.90  identical on the legal-suffix-stripped core (e.g. "Google" == "Google LLC")
 *   strong      0.75-0.89  high fuzzy similarity on the core
 *   weak        0.40-0.74  partial similarity (surfaced but below default accept)
 *   none        <0.40      effectively no match
 */
function scoreCandidate(inputName, candidateName) {
  const inRaw = String(inputName || '').trim();
  const candRaw = String(candidateName || '').trim();
  if (!inRaw || !candRaw) return { confidence: 0, tier: 'none' };

  if (inRaw.toLowerCase() === candRaw.toLowerCase()) {
    return { confidence: 1.0, tier: 'exact' };
  }
  const inLoose = normalizeLoose(inRaw);
  const candLoose = normalizeLoose(candRaw);
  if (inLoose === candLoose) return { confidence: 0.97, tier: 'normalized' };

  const inCore = normalizeCore(inRaw);
  const candCore = normalizeCore(candRaw);
  if (inCore && inCore === candCore) return { confidence: 0.9, tier: 'core' };

  // Fuzzy: blend whole-string bigram-dice with a token-aware soft Jaccard on the
  // cores. The soft Jaccard tolerates per-word typos; dice guards word order.
  const dice = diceBigram(inCore, candCore);
  const soft = softTokenJaccard(inCore, candCore);
  const sim = 0.5 * dice + 0.5 * soft;

  let confidence;
  if (sim >= 0.92) confidence = 0.89;
  else if (sim >= 0.75) confidence = 0.75 + (sim - 0.75) * (0.14 / 0.17); // 0.75..0.89
  else if (sim >= 0.4) confidence = 0.4 + (sim - 0.4) * (0.34 / 0.35); // 0.40..0.74
  else confidence = Math.round(sim * 100) / 100;

  confidence = Math.round(confidence * 100) / 100;
  let tier;
  if (confidence >= 0.75) tier = 'strong';
  else if (confidence >= 0.4) tier = 'weak';
  else tier = 'none';
  return { confidence, tier };
}

// Pick the best-scoring candidate from a list; returns {candidate, confidence, tier} or null.
function bestMatch(inputName, candidates, nameField) {
  let best = null;
  for (const c of candidates || []) {
    const cand = typeof c === 'string' ? c : c[nameField];
    const s = scoreCandidate(inputName, cand);
    if (!best || s.confidence > best.confidence) {
      best = { candidate: c, confidence: s.confidence, tier: s.tier };
    }
    if (best.confidence >= 1.0) break;
  }
  return best;
}

module.exports = {
  normalizeLoose, normalizeCore, scoreCandidate, bestMatch,
  diceBigram, tokenJaccard, softTokenJaccard, LEGAL_SUFFIXES,
};
