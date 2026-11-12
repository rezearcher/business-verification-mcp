#!/usr/bin/env node
// Grey Ridge business-verification-mcp — a zero-dependency Model Context Protocol
// server that verifies US businesses against official state sources and screens
// them against the OFAC SDN sanctions list.
//
// Transport: MCP stdio — newline-delimited JSON-RPC 2.0 on stdin/stdout, per the
// Model Context Protocol spec. No SDK, no dependencies: the server installs and
// boots instantly under `npx`, and drags in no transitive package surface (the
// thing an agent tool should least of all carry). See test/roundtrip.mjs for a
// real client handshake plus a live verification.
//
// Every record is built from keyless public-domain official sources via the
// vendored core in ./src — the same maintained adapter layer behind the Grey
// Ridge hosted verification rail. No API key, no account.

import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { verifyOne, lookupEntity, enumerateEntities } = require(join(__dirname, 'src', 'verify.js'));
const { loadOfacIndex, screenName, verdictFor } = require(join(__dirname, 'src', 'sanctions.js'));
const { listStates } = require(join(__dirname, 'src', 'sources', 'index.js'));
const { resolveLei, fetchRecord, relationParent, parentChain, directChildren } = require(join(__dirname, 'src', 'gleif_ownership.js'));

const SERVER_INFO = { name: 'greyridge-business-verification-mcp', version: '0.7.0' };
const DEFAULT_PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

// Coverage is DERIVED from the vendored source registry at runtime, never a
// hardcoded roster — add a state in src/sources and it appears here automatically.
const STATES = listStates();

// ---- hosted batch rail (honest upsell, never a blocker) --------------------
// The two tools below run the full verification locally and free. The hosted
// Apify rail does the same core work at batch scale with managed per-match
// metering (pay-per-event, USD, billed only on a verified match) — for callers
// who do not want to run this stdio server over thousands of rows themselves.
const PREMIUM = {
  service: 'Grey Ridge US Business Verification — hosted batch rail',
  rail: 'Apify Store (pay-per-event, USD, billed only on a verified match)',
  url: 'https://apify.com/greyridge-signals/us-business-verification',
  price_usd_per_verified_match: 0.01,
  what:
    'Batch-verify thousands of businesses in one managed run against the same official state ' +
    'sources, with the UCC-lien profile (CO) and OFAC SDN screen on every match, metered and ' +
    'billed only on a confirmed match. No-matches are free.',
  why_paid:
    'Managed, high-volume, metered runs with per-match billing and run history — the hosted ' +
    'convenience layer over the same keyless core these free tools expose.',
};

const SEE_ALSO = {
  note:
    'These results are live and free. For managed high-volume batch verification with per-match ' +
    'metered billing, use the hosted rail below.',
  hosted_rail_url: PREMIUM.url,
  hosted_rail_price_usd_per_verified_match: PREMIUM.price_usd_per_verified_match,
};

// Ownership-graph (GLEIF Level-2) upsell. The free result proves the capability and
// answers the money questions (who ultimately controls this entity, does it own
// subsidiaries), bounded to one page + the multi-hop parent chain. The hosted rail
// delivers the FULL recursive N-level subsidiary tree and resolves each node's
// registeredAs against the live national register (a confirmed join, not a hint).
const OWNERSHIP_LOCKED_FIELDS = [
  'full recursive N-level subsidiary tree (every level, every child)',
  'every direct child beyond the free sample page',
  'registeredAs CONFIRMED against the live national register per node (not just hinted)',
  'ultimate-children roll-up count + leaf enumeration',
];
const ownershipLockedBlock = () => ({
  locked: true,
  withheld: OWNERSHIP_LOCKED_FIELDS,
  unlock: `Full recursive ownership tree + confirmed national-register joins via the hosted rail (${PREMIUM.url}).`,
});

// ---- tool definitions ------------------------------------------------------

const TOOLS = [
  {
    name: 'verify_business',
    description:
      'KYB / know-your-business verification. ' +
      'Verify one or more US businesses against official, keyless state business-registry sources ' +
      '(currently NY, CO, CT). Each business may be a bare name string ("Palantir Technologies") or ' +
      'an object {name, state}. Returns one record per input with a scored match_confidence, the ' +
      'official entity_name, entity_id, status (+ normalized status), entity_type, formation_date, ' +
      'jurisdiction, registered_agent and principal_address — plus the exact source_url and ' +
      'retrieved_at timestamp. On a Colorado match it attaches a UCC-lien profile (active liens, ' +
      'secured parties, dates). By default every match is also screened against the OFAC SDN ' +
      'sanctions list (set includeSanctions:false to skip). No-matches return a defensible audit ' +
      'record (no_match_reason + candidates), never a bare false. Every record carries a field_safety ' +
      'block: the registry-sourced free-text fields (entity name, registered agent, address, candidate ' +
      'names) are screened for indirect prompt injection and tool poisoning (OWASP LLM01 / MCP ' +
      'tool-poisoning) before your agent ingests them — flag-only, the verbatim value is preserved. ' +
      'WHEN TO USE: you have a business NAME. If you already hold the registry entity_id use ' +
      'lookup_entity (exact, no scoring); to list many businesses by a name prefix use search_entities; ' +
      'for an OFAC-only check with no registry lookup use screen_sanctions. Keyless, public-domain ' +
      'sources, no API key.',
    inputSchema: {
      type: 'object',
      properties: {
        businesses: {
          type: 'array',
          items: { type: ['string', 'object'] },
          description: 'Business names (strings) or {name, state} objects. At least one required.',
          minItems: 1,
        },
        state: {
          type: 'string',
          description: 'Optional default 2-letter state to scope all lookups (NY, CO, CT). Omit to try all live states.',
        },
        minConfidence: {
          type: 'number',
          description: 'Minimum match_confidence (0-1) for matched=true. Default 0.85.',
          default: 0.85,
        },
        includeUcc: {
          type: 'boolean',
          description: 'Attach the CO UCC-lien profile on Colorado matches. Default true.',
          default: true,
        },
        includeSanctions: {
          type: 'boolean',
          description: 'Screen each match against the OFAC SDN sanctions list. Default true.',
          default: true,
        },
        maxItems: {
          type: 'integer',
          description: 'Cap the number of businesses verified in one call. Default 50, max 200.',
          default: 50,
        },
      },
      required: ['businesses'],
      additionalProperties: false,
    },
  },
  {
    name: 'screen_sanctions',
    description:
      'OFAC SDN sanctions screening / watchlist screen per name. ' +
      'Screen one or more names directly against the live OFAC SDN (Specially Designated Nationals) ' +
      'sanctions list — no state lookup. Returns per-name verdict (clear | potential_match | match), ' +
      'matched program(s), the alias or primary name that matched, a confidence score, and the exact ' +
      'OFAC source URL. The list is downloaded live per call (freshness: delisted entities correctly ' +
      'return clear). Matching uses distinctiveness learned from the list itself (IDF-weighted ' +
      'contiguous-phrase containment), not a naive substring, to suppress false positives. ' +
      'WHEN TO USE: a pure OFAC watchlist check on names, with NO state registry lookup. If you want ' +
      'to verify a business in a registry (which already includes this OFAC screen on each match), use ' +
      'verify_business instead.',
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names (person or business) to screen. At least one required.',
          minItems: 1,
        },
        minConfidence: {
          type: 'number',
          description: 'Minimum confidence (0-1) for a reported hit. Default 0.85.',
          default: 0.85,
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_states',
    description:
      'List the US states currently verifiable through this server (keyless, public-domain official ' +
      'registries) and how each is addressed. No network call.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lookup_entity',
    description:
      'Authoritative lookup of ONE business by its registry entity_id within a state. Unlike ' +
      'verify_business this does NO fuzzy name matching — the entity_id is the registry primary key, so ' +
      'a hit is the single canonical row (match_confidence 1.0, match_tier "exact_id"). Returns the ' +
      'same full record as a verified match: status (+ normalized), entity_type, formation_date, ' +
      'jurisdiction, registered_agent, principal_address, source_url, the CO UCC-lien profile and OFAC ' +
      'screen where applicable, and a field_safety block. WHEN TO USE: you already have an entity_id ' +
      '(e.g. from a prior verify_business or search_entities result) and want to re-resolve it exactly ' +
      'or refresh its status. If you only have a name, use verify_business or search_entities. ' +
      'matched=false (never fabricated) when the id is unknown or the state is unsupported.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'Required 2-letter state the entity_id belongs to (NY, CO, CT).' },
        entityId: { type: 'string', description: 'The registry entity_id to resolve (as returned in a prior result).' },
        includeUcc: { type: 'boolean', description: 'Attach the CO UCC-lien profile on a Colorado entity. Default true.', default: true },
        includeSanctions: { type: 'boolean', description: 'Run the OFAC SDN screen on the resolved entity. Default true.', default: true },
      },
      required: ['state', 'entityId'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_entities',
    description:
      'Browse / enumerate businesses within ONE state whose official name begins with (then contains) a ' +
      'fragment — the "list the companies in this state" surface. Unlike verify_business (which collapses ' +
      'to the single best match) this returns a bounded, name-ordered LIST of candidate entities, each ' +
      'with entity_name, entity_id, status, entity_type, formation_date, jurisdiction, registered_agent ' +
      'and source_url, plus a field_safety screen over the batch. WHEN TO USE: you want to discover or ' +
      'disambiguate the entities under a name stem (e.g. all "ACME *" filings in Colorado), or collect ' +
      'entity_ids to feed lookup_entity. For a single known business use verify_business; for a known ' +
      'id use lookup_entity. Keyless, public-domain official registries.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'Required 2-letter state to enumerate within (NY, CO, CT).' },
        name: { type: 'string', description: 'Name fragment to match from the start of the entity name (min 2 chars).' },
        limit: { type: 'integer', description: 'Max entities to return. Default 25, max 50.', default: 25 },
      },
      required: ['state', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'map_ownership',
    description:
      'Corporate OWNERSHIP GRAPH / UBO (ultimate beneficial owner) tracer for a company. ' +
      'Given a company NAME or its LEI, trace its ownership using the keyless GLEIF Global LEI ' +
      'relationship register (Level-2, CC0 public domain): the ultimate parent (the UBO control ' +
      'anchor), the full multi-hop parent CHAIN walked up level by level (not a single hop), and the ' +
      'direct subsidiaries with the TRUE total count. Each node also carries registeredAs — its ' +
      'authoritative national-register number (French SIREN, German HRB, etc.) — plus a ' +
      'national_register hint naming which official register can confirm it, the connected link ' +
      'between the global ownership graph and a per-country registry that flat LEI scrapers do not ' +
      'join. Returns the UBO anchor, the parent chain, and one bounded page of direct children with ' +
      'the real subsidiary total; the full recursive N-level subsidiary tree and each node\'s ' +
      'registeredAs CONFIRMED against the live national register are delivered by the hosted rail in ' +
      'see_also. WHEN TO USE: you need who ultimately owns/controls a company, or its corporate family ' +
      '(parents + subsidiaries). For a plain is-it-real/active check use verify_business; for an OFAC ' +
      'watchlist check use screen_sanctions. Keyless, no API key. Resolution is guarded (a name only ' +
      'resolves on a strong leading-token match), and a company with no reported parent is honestly ' +
      'reported as an ultimate parent, not an error.',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company legal name to resolve to an LEI (e.g. "Alphabet Inc"). Provide this OR lei.' },
        lei: { type: 'string', description: 'A 20-char LEI to trace directly (skips name resolution). Provide this OR company.' },
        maxChildren: { type: 'integer', description: 'Max direct subsidiaries in the free sample page. Default 10, max 15 (the full set is on the hosted rail).', default: 10 },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

// ---- tool handlers ---------------------------------------------------------

function clampItems(v, def = 50) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), 200);
}

function normalizeRows(businesses, defaultState) {
  if (!Array.isArray(businesses)) return [];
  return businesses
    .map((b) => {
      if (typeof b === 'string') return { name: b, state: defaultState || null };
      if (b && typeof b === 'object') {
        const name = String(b.name || b.entity_name || '').trim();
        if (!name) return null;
        return { name, state: (b.state ? String(b.state).toUpperCase() : defaultState) || null };
      }
      return null;
    })
    .filter(Boolean);
}

async function toolVerifyBusiness(args) {
  const defaultState = args?.state ? String(args.state).toUpperCase() : null;
  const rows = normalizeRows(args?.businesses, defaultState).slice(0, clampItems(args?.maxItems));
  if (rows.length === 0) throw new Error('`businesses` must be a non-empty array of names or {name,state} objects');

  const minConfidence = typeof args?.minConfidence === 'number' ? args.minConfidence : 0.85;
  const includeUcc = args?.includeUcc !== false;
  const includeSanctions = args?.includeSanctions !== false;

  // Load the OFAC list ONCE for the whole call (not per row). Degrades open: a
  // load failure leaves each screen verdict 'unknown', never blocks a match.
  let sanctionsIndex = null;
  if (includeSanctions) {
    try { sanctionsIndex = (await loadOfacIndex({ timeoutMs: 45000 })).index; }
    catch { /* degrade open */ }
  }

  const records = [];
  let verified = 0;
  let flagged = 0;
  for (const row of rows) {
    let rec;
    try {
      rec = await verifyOne(row, {
        minConfidence,
        states: row.state ? [row.state] : null,
        includeUcc,
        includeSanctions,
        sanctionsIndex,
        timeoutMs: 20000,
      });
    } catch (e) {
      rec = { input_name: String(row.name || ''), matched: false, error: e?.message || String(e), retrieved_at: new Date().toISOString() };
    }
    if (rec.matched === true) verified++;
    if (rec.sanctions && (rec.sanctions.verdict === 'match' || rec.sanctions.verdict === 'potential_match')) flagged++;
    records.push(rec);
  }

  return {
    query: { count: rows.length, state: defaultState, minConfidence, includeUcc, includeSanctions },
    verified_matches: verified,
    sanctions_flagged: flagged,
    results: records,
    see_also: SEE_ALSO,
  };
}

async function toolScreenSanctions(args) {
  const names = Array.isArray(args?.names) ? args.names.filter((n) => typeof n === 'string' && n.trim()) : [];
  if (names.length === 0) throw new Error('`names` must be a non-empty array of strings');
  const minConfidence = typeof args?.minConfidence === 'number' ? args.minConfidence : 0.85;

  const loaded = await loadOfacIndex({ timeoutMs: 45000 });
  const index = loaded.index;
  const results = names.map((name) => {
    const hits = screenName(name, index, minConfidence);
    const verdict = verdictFor(hits, minConfidence);
    return { name, verdict, hits };
  });
  return {
    source: 'ofac-sdn',
    list_counts: loaded.counts,
    min_confidence: minConfidence,
    count: names.length,
    results,
  };
}

function toolListStates() {
  const notes = {
    NY: 'New York Dept. of State business entities (Socrata, public domain). Scored match + status.',
    CO: 'Colorado Secretary of State business entities + UCC-lien family (Socrata, public domain). Match + UCC profile.',
    CT: 'Connecticut Secretary of the State Business Registry (Socrata, public domain). Explicit status + registered agent.',
  };
  return {
    states: STATES,
    count: STATES.length,
    addressing: Object.fromEntries(STATES.map((s) => [s, notes[s] || 'keyless public-domain official registry'])),
    note: 'Pass a business name with an optional 2-letter state. Omit state to try all live states.',
  };
}

async function toolLookupEntity(args) {
  const state = args?.state ? String(args.state).toUpperCase() : '';
  const entityId = args?.entityId != null ? String(args.entityId) : '';
  let sanctionsIndex = null;
  if (args?.includeSanctions !== false) {
    try { sanctionsIndex = (await loadOfacIndex({ timeoutMs: 45000 })).index; } catch { /* degrade open */ }
  }
  const rec = await lookupEntity({ state, entityId }, {
    includeUcc: args?.includeUcc !== false,
    includeSanctions: args?.includeSanctions !== false,
    sanctionsIndex,
    timeoutMs: 20000,
  });
  return { ...rec, see_also: SEE_ALSO };
}

async function toolSearchEntities(args) {
  const state = args?.state ? String(args.state).toUpperCase() : '';
  const name = args?.name != null ? String(args.name) : '';
  const out = await enumerateEntities({ state, name, limit: args?.limit }, { timeoutMs: 20000 });
  return { ...out, see_also: SEE_ALSO };
}

function ownNode(n) {
  if (!n || typeof n !== 'object') return n;
  return {
    lei: n.lei ?? null,
    name: n.name ?? null,
    country: n.country ?? null,
    status: n.status ?? null,
    registered_as: n.registered_as ?? null,
    national_register: n.national_register ?? null,
    source_url: n.source_url ?? null,
  };
}

const OWN_BUDGET_MS = 12000;

async function toolMapOwnership(args) {
  const company = typeof args?.company === 'string' ? args.company.trim() : '';
  let lei = typeof args?.lei === 'string' ? args.lei.trim().toUpperCase() : '';
  const maxChildren = Math.min(Math.max(1, Number(args?.maxChildren) || 10), 15);
  if (!company && !lei) throw new Error('provide `company` (a name) or `lei` (a 20-char LEI)');

  let resolution = null;
  if (!lei) {
    resolution = await resolveLei(company, { timeoutMs: OWN_BUDGET_MS });
    if (!resolution.lei) {
      return {
        query: { company, maxChildren },
        resolved: null,
        no_resolution_reason: 'no_strong_lei_match',
        note:
          'No GLEIF LEI resolved with a strong leading-token match for this name. LEI coverage is ' +
          'incomplete for small/private firms; try the exact legal name or pass the LEI directly. ' +
          '(Absence is reported, never a fabricated owner.)',
        candidate_count: Array.isArray(resolution.candidates) ? resolution.candidates.length : 0,
        see_also: SEE_ALSO,
      };
    }
    lei = resolution.lei;
  }
  if (!/^[A-Z0-9]{20}$/.test(lei)) throw new Error('`lei` must be a 20-character LEI');

  const entity = await fetchRecord(lei, { timeoutMs: OWN_BUDGET_MS, withHint: true });
  if (!entity) {
    return {
      query: { company: company || undefined, lei, maxChildren },
      resolved: null,
      no_resolution_reason: 'lei_not_found',
      note: 'That LEI is not present in the GLEIF register.',
      see_also: SEE_ALSO,
    };
  }
  const [chain, ultimate, children] = await Promise.all([
    parentChain(lei, { maxHops: 6, timeoutMs: OWN_BUDGET_MS }).catch(() => []),
    relationParent(lei, 'ultimate-parent', { timeoutMs: OWN_BUDGET_MS }).catch(() => null),
    directChildren(lei, { limit: maxChildren, timeoutMs: OWN_BUDGET_MS }).catch(() => ({ total: 0, sample: [] })),
  ]);

  const isUltimate = (!ultimate || ultimate.lei === lei) && chain.length === 0;
  const sample = (children.sample || []).map(ownNode);
  const joinableCount = sample.filter((n) => n.national_register && n.national_register.joinable).length;

  return {
    query: { company: company || undefined, lei, maxChildren },
    resolved: ownNode(entity),
    is_ultimate_parent: isUltimate,
    ultimate_parent: ultimate && ultimate.lei !== lei ? ownNode(ultimate) : null,
    parent_chain: chain.map(ownNode),
    parent_chain_depth: chain.length,
    subsidiaries: {
      total: children.total || 0,
      sample,
      sample_count: sample.length,
      has_more: (children.total || 0) > sample.length,
    },
    connected_registry: {
      note:
        'Each node carries registeredAs (its national-register number) and a national_register hint. The ' +
        'hosted rail resolves these against the live FR/NO/CZ/FI/PL registers for a confirmed cross-join.',
      joinable_in_sample: joinableCount,
    },
    full_graph_locked: ownershipLockedBlock(),
    source: 'GLEIF Global LEI relationship register (CC0 public domain, keyless)',
    see_also: SEE_ALSO,
  };
}

async function dispatchTool(name, args) {
  switch (name) {
    case 'verify_business': return toolVerifyBusiness(args);
    case 'screen_sanctions': return toolScreenSanctions(args);
    case 'list_states': return toolListStates();
    case 'lookup_entity': return toolLookupEntity(args);
    case 'search_entities': return toolSearchEntities(args);
    case 'map_ownership': return toolMapOwnership(args);
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// ---- JSON-RPC / MCP plumbing ----------------------------------------------

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function result(id, res) { send({ jsonrpc: '2.0', id, result: res }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null && msg.id !== undefined;
  if (!isRequest) return; // notifications: never reply

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
      result(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'US business verification against official state sources. Tool map: list_states for coverage; ' +
          'verify_business when you have a NAME (scored match + status + formation + UCC + OFAC screen); ' +
          'lookup_entity when you already have the registry entity_id (one authoritative row, no scoring); ' +
          'search_entities to browse/enumerate every business in a state by a name prefix; screen_sanctions ' +
          'for an OFAC-only watchlist check with no registry lookup; map_ownership to trace a company\'s ' +
          'corporate ownership graph / UBO (ultimate parent + subsidiaries) via the keyless GLEIF Global ' +
          'LEI register. Free and keyless. A managed ' +
          'high-volume batch rail with per-match billing is linked in each result (see_also).',
      });
      return;
    }
    case 'ping': result(id, {}); return;
    case 'tools/list': result(id, { tools: TOOLS }); return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const data = await dispatchTool(name, args);
        result(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        result(id, { content: [{ type: 'text', text: `error: ${e?.message || String(e)}` }], isError: true });
      }
      return;
    }
    default: error(id, -32601, `method not found: ${method}`);
  }
}

function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let inFlight = 0;
  let closed = false;
  const maybeExit = () => { if (closed && inFlight === 0) process.exit(0); };
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); }
    catch { error(null, -32700, 'parse error'); return; }
    inFlight += 1;
    handle(msg)
      .catch((e) => { if (msg && msg.id !== undefined && msg.id !== null) error(msg.id, -32603, `internal error: ${e?.message || e}`); })
      .finally(() => { inFlight -= 1; maybeExit(); });
  });
  rl.on('close', () => { closed = true; maybeExit(); });
}

main();
