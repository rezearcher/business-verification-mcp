# Vendored core

`src/` is vendored verbatim from the `us-business-verification` actor in the
asset-factory monorepo — the same maintained adapter layer behind the hosted
rail. This MCP server imports `verifyOne` (verify.js) and the OFAC screen
(sanctions.js) directly; nothing here forks the logic.

- Vendor source: `actors/us-business-verification/src/`
- Vendored at monorepo commit: `4e762963486d177b06259b2136251abcdfa4fbd2`
- Vendored files: `src/*.js` + `src/sources/*.js` (zero external dependencies —
  Node builtins only; `apify` is never imported by the vendored core).

To refresh after the actor changes: copy `actors/us-business-verification/src/`
over `src/` here, bump the commit above, and run `npm test` (a real MCP
handshake + a live verification + a live OFAC load must pass before shipping).
