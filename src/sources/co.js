'use strict';

// Colorado — Secretary of State business entities.
// Open dataset 4ykn-tg5h on data.colorado.gov (Colorado Information Marketplace,
// Socrata). Keyless. Terms: Colorado Information Marketplace Terms of Use — the
// state's official open-data portal, published for public reuse (reviewed
// 2026-11-05, see README "Source terms").
//
// Richest keyless source: carries an EXPLICIT entitystatus ("Good Standing",
// "Administratively Dissolved", ...), registered agent, principal address and
// formation date in one dataset.

const { fetchCandidates } = require('./socrata');

const DATASET = '4ykn-tg5h';
const BASE = `https://data.colorado.gov/resource/${DATASET}.json`;
const HUMAN = `https://data.colorado.gov/d/${DATASET}`;

function agentName(r) {
  const parts = [r.agentfirstname, r.agentmiddlename, r.agentlastname].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

async function search(name, opts = {}) {
  const rows = await fetchCandidates(BASE, {
    nameField: 'entityname',
    idField: 'entityid',
    name,
    limit: opts.limit || 25,
    opts,
  });
  return rows.map((r) => ({
    _name: r.entityname,
    entityName: r.entityname,
    entityId: r.entityid,
    statusRaw: r.entitystatus || null,
    entityType: r.entitytype || null,
    formationDate: r.entityformdate || null,
    jurisdiction: r.jurisdictonofformation || null, // (sic) upstream spelling
    registeredAgent: agentName(r),
    principalAddress: [r.principaladdress1, r.principaladdress2, r.principalcity, r.principalstate, r.principalzipcode]
      .filter(Boolean).join(', ') || null,
    sourceUrl: `${BASE}?$where=entityid='${r.entityid}'`,
  }));
}

module.exports = {
  state: 'CO',
  label: 'Colorado Secretary of State',
  human_url: HUMAN,
  has_explicit_status: true,
  search,
};
