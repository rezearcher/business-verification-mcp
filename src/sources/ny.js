'use strict';

// New York — Department of State, "Active Corporations: Beginning 1800".
// Open dataset n9v6-gdp6 on data.ny.gov (Socrata). Keyless.
// Terms: OPEN-NY Terms of Use — "among the least restrictive... use it however
// you wish, in private sector projects... subject to no other requirements"
// (verified 2026-11-05, see README "Source terms"). Commercial reuse permitted.
//
// NOTE: this dataset lists ACTIVE corporations/LLCs; presence ~= active standing.
// There is no explicit status column, so status is reported as "Active (listed)".

const { fetchCandidates, lookupById: lookupByIdRaw, enumerate: enumerateRaw } = require('./socrata');

const DATASET = 'n9v6-gdp6';
const BASE = `https://data.ny.gov/resource/${DATASET}.json`;
const HUMAN = `https://data.ny.gov/d/${DATASET}`;
const NAME_FIELD = 'current_entity_name';
const ID_FIELD = 'dos_id';

function mapRow(r) {
  return {
    _name: r.current_entity_name,
    entityName: r.current_entity_name,
    entityId: r.dos_id,
    // Dataset is "Active Corporations" — listing implies active standing.
    statusRaw: 'Active (listed)',
    entityType: r.entity_type || null,
    formationDate: r.initial_dos_filing_date || null,
    jurisdiction: r.jurisdiction || null,
    registeredAgent: r.registered_agent_name
      || r.dos_process_name
      || null,
    principalAddress: [r.dos_process_address_1, r.dos_process_address_2, r.dos_process_city, r.dos_process_state, r.dos_process_zip]
      .filter(Boolean).join(', ') || null,
    sourceUrl: `${BASE}?$where=dos_id='${r.dos_id}'`,
  };
}

async function search(name, opts = {}) {
  const rows = await fetchCandidates(BASE, { nameField: NAME_FIELD, idField: ID_FIELD, name, limit: opts.limit || 25, opts });
  return rows.map(mapRow);
}

async function lookupById(id, opts = {}) {
  const rows = await lookupByIdRaw(BASE, { idField: ID_FIELD, id, opts });
  return rows.map(mapRow);
}

async function enumerate(name, opts = {}) {
  const rows = await enumerateRaw(BASE, { nameField: NAME_FIELD, name, limit: opts.limit || 25, opts });
  return rows.map(mapRow);
}

module.exports = {
  state: 'NY',
  label: 'New York Department of State',
  human_url: HUMAN,
  has_explicit_status: false,
  id_field: ID_FIELD,
  search,
  lookupById,
  enumerate,
};
