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
const { verifyOne } = require(join(__dirname, 'src', 'verify.js'));
const { loadOfacIndex, screenName, verdictFor } = require(join(__dirname, 'src', 'sanctions.js'));
const { listStates } = require(join(__dirname, 'src', 'sources', 'index.js'));

const SERVER_INFO = { name: 'greyridge-business-verification-mcp', version: '0.2.0' };
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
    'billing, call get_hosted_access.',
  hosted_tool: 'get_hosted_access',
};

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
      'sanctions list. No-matches return a defensible audit record (no_match_reason + candidates), ' +
      'never a bare false. Every record carries a field_safety block: the registry-sourced free-text ' +
      'fields (entity name, registered agent, address, candidate names) are screened for indirect ' +
      'prompt injection and tool poisoning (OWASP LLM01 / MCP tool-poisoning) before your agent ' +
      'ingests them — flag-only, the verbatim value is preserved. Keyless, public-domain sources, no API key.',
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
      'contiguous-phrase containment), not a naive substring, to suppress false positives.',
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
    name: 'get_hosted_access',
    description:
      'Describe the hosted batch verification rail available beyond this free server: the same core ' +
      'run managed at high volume with per-match metered billing (pay-per-event, USD, billed only on ' +
      'a verified match). Returns the rail URL, price, and what it adds. No network call, no payment.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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

function toolGetHostedAccess() {
  return { ...PREMIUM, note: 'The verify_business and screen_sanctions tools on this server are free and keyless. The hosted rail is for managed, high-volume, metered batch runs.' };
}

async function dispatchTool(name, args) {
  switch (name) {
    case 'verify_business': return toolVerifyBusiness(args);
    case 'screen_sanctions': return toolScreenSanctions(args);
    case 'list_states': return toolListStates();
    case 'get_hosted_access': return toolGetHostedAccess();
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
          'US business verification against official state sources. Call list_states for coverage, ' +
          'verify_business to verify one or more businesses (scored match + status + formation + UCC + ' +
          'OFAC screen), and screen_sanctions to check names against the live OFAC SDN list. These are ' +
          'free and keyless. For managed high-volume batch runs with per-match billing, call ' +
          'get_hosted_access.',
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
