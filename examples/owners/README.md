# Wika owners preview

A small local dashboard over the authoritative safe-claims node, built with `@wika/core` and `@wika/react`. This is a usable starting point for page owners; the broader monitoring application is planned as a separate codebase.

From the React workspace root:

```sh
npm install
npm run dev:owners
```

Open http://127.0.0.1:3016 and connect a safe-claims node (runtime 402; default `ws://127.0.0.1:9944`). Set `VITE_WIKA_NODE_URL`, `VITE_WIKA_INDEXER_URL` (default `http://127.0.0.1:3000`) and optionally `VITE_WIKA_GENESIS_HASH` to configure the initial endpoint and pin chain identity. A browser wallet supporting injected message and transaction signing is needed for actions. Viewing pages and addresses needs no wallet connection.

- Connect a wallet or paste an address to discover its current and historical ownership periods, pending verification requests and replacement candidacies through the financial indexer. Choose among connected accounts when the wallet provides more than one.
- Load portfolios in batches of up to 20 records from each account-indexed feed. The 25-page watchlist limit does not apply to portfolio discovery.
- Open a discovered page directly in the shared claim controls; historical records open the exact earlier period, even when it is older than the latest five.
- Save up to 25 page URLs, separately per chain, in this browser's local storage.
- Inspect current ownership, earnings and replacement deadlines; filter by a viewed wallet.
- Use shared claim controls for proofs, verification, withdrawals and replacement responses.
- Browse earlier ownership periods in batches of five. Historical withdrawals require the original wallet, review the amount and fee, and finalize on-chain.

The read-only wallet view does not authorize transactions. Choose the signing account in the claim controls; historical withdrawals find the original account in the connected wallet. No private keys or seed phrases are collected. Quotes are estimates and are rechecked before signing; the node enforces eligibility.

The wallet portfolio needs the current financial SubQuery schema, replayed from block 1 with block-height historical queries enabled. It checks the indexer genesis hash against the connected node. The query service must permit this dashboard’s origin; see the ETL setup for the query endpoint. Discovery pins all account-filtered cursor queries to one indexed block, capped at the node’s finalized height. Wika AccountId32 addresses are normalized to the chain’s SS58 format 42 before querying. No chain-wide storage scan runs in the browser.

The portfolio displays indexed height, node finalized height at discovery, indexing lag, last processing time, unknown/unhealthy indexer status and remaining pagination. “All indexed records” applies only to that snapshot and the indexer’s replay; recent activity may be absent. Use **Refresh discovery** to find changes. Amounts and withdrawability come from node-checked periods, using exact bigint base units, with at most three row checks in flight per refresh. Portfolio totals cover only the successfully checked records loaded here; current, earlier and withdrawable amounts are separated. Failed refreshes remove previous amounts from these totals and disable that row’s action. Node balances refresh every 30 seconds while visible, through **Refresh balances**, and after a finalized historical withdrawal. Checks across rows are separate node snapshots. Pending verification account attribution remains an indexed hint; the shared controls read current node state and recheck before signing.

An unavailable or wrong-chain indexer does not disable the saved watchlist. Its current earnings totals exclude failed reads and do not include historical periods. Page snapshots refresh every 30 seconds while visible, with at most three page reads in flight. Failed reads retain clearly marked last-seen data, excluded from totals. History is explicitly refreshed. The embedded claim controls also poll the selected page.

Alerts require the dashboard to be open. Email/push delivery and native extension alerts are pending. No deployment, separate monitoring repository, node administration or validator controls are included. The future monitoring product should cover owners, node operators, consensus validators and external claim verifiers with separate roles and data adapters.

Run `npm run check` at the workspace root for type checking, tests and all builds. Development economics and limits have not been approved for production.

Additional integration checks (no deployment):

- `WIKA_TEST_DB_PORT=<isolated-postgres-port> npm run test:portfolio-indexer` builds core and exercises its actual queries against the sibling ETL’s installed query service and disposable seeded tables. It checks independent pagination, exact period ids, SS58 normalization, account/request filters and a stable snapshot as the indexed height advances. The test database uses localhost / postgres / postgres. This is a query contract test; it does not drive fresh chain events through the indexer.
- With `npm run dev:owners` running, `npm run test:portfolio-browser` checks desktop and mobile layouts and a historical withdrawal review using controlled node/indexer fixtures. It uses the sibling extension’s installed Playwright; set `CHROME_PATH` for older macOS or `WIKA_OWNERS_REVIEW_URL` for another local port. It creates temporary review files, removes them afterward, and saves screenshots under `compatibility/reports/portfolio-browser/`. It sends no transactions. Chromium must be installed as described in the extension README.

The complete native journey is available as `npm run test:portfolio-live` from the React workspace. It starts its own temporary development node and dashboard server, then runs the sibling ETL's finalized financial scenario with a real Chromium dashboard attached. It covers first ownership/backlog, a pending replacement with held withdrawals, new-owner earnings, old-owner earnings, and a historical withdrawal signed and finalized through the dashboard. The indexer must reflect the withdrawal without changing the new owner's earnings. It sends real transactions only on the owned local development chain; the website proof and injected development signer remain explicit fixtures. Browser RPC and GraphQL requests are real.

Use an isolated PostgreSQL with `btree_gist` already enabled through `WIKA_TEST_DB_PORT` (the ETL test's database environment settings apply). Alternatively, set `WIKA_EMBEDDED_POSTGRES_MODULE` to the absolute entrypoint of an installed `embedded-postgres` package: the runner creates a disposable database, enables `btree_gist` only there, and removes it afterward. It does not select a pre-existing database automatically. Set `CHROME_PATH` when needed. On older macOS, `LC_ALL=C LANG=C` avoids invalid inherited locale settings during database initialization. The node binary defaults to the sibling `wika_node/target/release/wika-node`; override `WIKA_NODE_BINARY` if necessary. Query/indexer fixture ports 13101/13100 must be free. No separate node terminal is needed.

The runner rebuilds the consumers and ETL, writes an unsuccessful result before starting, saves stage results, screenshots, service/test logs and source fingerprints under `compatibility/reports/portfolio-live/`, and stops its temporary services. Override `WIKA_PORTFOLIO_REPORT_DIRECTORY` for a separate evidence directory. This native gate does not replace Linux/container validation, production DNS/TLS checks, or a native-extension signing test.
