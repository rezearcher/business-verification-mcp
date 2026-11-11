'use strict';

// Connecticut — Secretary of the State, Business Registry.
// Business Master dataset n7gp-d28j on data.ct.gov (Socrata). Keyless.
// License: Public Domain (Socrata metadata licenseId PUBLIC_DOMAIN,
// attribution "Secretary of the State"), verified 2026-11-05 via the dataset
// views API. See README "Source terms".
//
// Registered-agent enrichment joins the Agents sub-table qh2m-n44y (part of the
// same official CT Business Registry, same publisher) on
// business_key == Business Master id, in a single batched query.
//
// Carries an EXPLICIT multi-value status ("Active", "Dissolved", "Forfeited",
// "Cancelled", "Merged", ...), a registration date, mailing address, and the
// joined registered agent — field parity with Colorado.

const { fetchCandidates, sodaGet, soqlQuote, lookupById: lookupByIdRaw, enumerate: enumerateRaw } = require('./socrata');

const DATASET = 'n7gp-d28j';
const AGENTS = 'qh2m-n44y';
const BASE = `https://data.ct.gov/resource/${DATASET}.json`;
const AGENTS_BASE = `https://data.ct.gov/resource/${AGENTS}.json`;
const HUMAN = `https://data.ct.gov/d/${DATASET}`;
const NAME_FIELD = 'name';
const ID_FIELD = 'id';

// CT uses year 0001 as a null/placeholder registration date (e.g. Reserved names).
function cleanDate(v) {
  if (!v) return null;
  // CT's SQL null-date sentinel is year 0001 (also guard 0000); never a real
  // registration date. Keep legitimate old dates (NY has 1800s corps elsewhere).
  if (/^000[01]-/.test(String(v))) return null;
  return v;
}

// Mailing address arrives as a single comma-joined string; ", , , , ," when empty.
function cleanAddress(v) {
  if (!v) return null;
  const parts = String(v).split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// Batch-resolve registered agents for a set of Business Master ids in ONE query.
// Agent enrichment degrades OPEN: any failure returns {} and the match still
// stands, agent null.
async function fetchAgents(ids, opts) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return {};
  const inList = uniq.map((id) => `'${soqlQuote(id)}'`).join(',');
  let rows;
  try {
    rows = await sodaGet(AGENTS_BASE, {
      $where: `business_key in(${inList})`,
      $limit: String(Math.max(50, uniq.length * 2)),
    }, opts);
  } catch (_) {
    return {};
  }
  const map = {};
  for (const r of rows || []) {
    const key = r.business_key;
    if (!key || map[key]) continue;
    map[key] = r.name__c || [r.firstname, r.lastname].filter(Boolean).join(' ') || null;
  }
  return map;
}

function mapRow(r, agentMap) {
  return {
    _name: r.name,
    entityName: r.name,
    entityId: r.accountnumber || r.id,
    statusRaw: r.status || null,
    entityType: null, // Business Master carries no entity-type column
    formationDate: cleanDate(r.date_registration),
    jurisdiction: null,
    registeredAgent: (agentMap && agentMap[r.id]) || null,
    principalAddress: cleanAddress(r.mailing_address),
    sourceUrl: `${BASE}?$where=id='${r.id}'`,
  };
}

// Join registered agents onto a set of Business Master rows in one batched query.
async function withAgents(rows, opts) {
  const agentMap = await fetchAgents(rows.map((r) => r.id), opts);
  return rows.map((r) => mapRow(r, agentMap));
}

async function search(name, opts = {}) {
  const rows = await fetchCandidates(BASE, { nameField: NAME_FIELD, idField: ID_FIELD, name, limit: opts.limit || 25, opts });
  return withAgents(rows, opts);
}

async function lookupById(id, opts = {}) {
  // The exposed entityId is accountnumber||id, so accept EITHER the dataset
  // primary key (id) or the public account number — whichever the agent echoes.
  const q = soqlQuote(String(id).trim());
  let rows;
  try {
    rows = await sodaGet(BASE, { $where: `id='${q}' OR accountnumber='${q}'`, $limit: '5' }, opts);
  } catch (_) {
    rows = await lookupByIdRaw(BASE, { idField: ID_FIELD, id, opts });
  }
  return withAgents(Array.isArray(rows) ? rows : [], opts);
}

async function enumerate(name, opts = {}) {
  const rows = await enumerateRaw(BASE, { nameField: NAME_FIELD, name, limit: opts.limit || 25, opts });
  return withAgents(rows, opts);
}

module.exports = {
  state: 'CT',
  label: 'Connecticut Secretary of the State',
  human_url: HUMAN,
  has_explicit_status: true,
  id_field: ID_FIELD,
  search,
  lookupById,
  enumerate,
};
