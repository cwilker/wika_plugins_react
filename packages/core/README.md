# @wika/core

Framework-independent TypeScript client for Wika Node 4.x. Exports `WikaClient`, `createInjectedWallet`, `WikaError`, `formatAmount`, URL/count validation, and public wallet/client interfaces. Token amounts use `bigint`; signing stays in the wallet. Builds ESM, CommonJS, declarations, and source maps.

See the repository README for usage, wallet adapters, lifecycle, and live tests. The initial package is available through local workspaces or `npm pack`; it has not been published.

## Safe page claims (runtime 402)

`client.supportsSafeClaims` detects the new protocol; `client.claims` returns a stable `WikaClaimsClient`. Its `getPage` and `getPeriod` read one node snapshot and preserve integer base units. Current, historical and frozen earnings are distinguished. `createProof` uses wallet message signing and exact genesis/page/account/nonce/chain-time bindings; unsupported `signRaw` fails explicitly. Keep the accepted tag in the server-delivered HTML head for later withdrawal checks.

Use `claims.quote(address, action)` before `claims.submit(account, signer, action, options)`. Actions cover claim, verification, withdrawal, replacement final check, cooperative approval, objection, cancellation, expiry and no-quorum retry. Network fee estimate, verification charge and refundable bond are separate. Submission rechecks authorization and pricing; `maxTotal` rejects a larger quote before signing, not changes to actual network fees after inclusion. Finalized transaction receipts do not imply that a separate website verification has completed.

Page identity v1 uses the Rust fixture corpus: ASCII URIs, A-label hostnames, percent-encoded Unicode text, preserved semantic queries and trailing slashes. Ambiguous numeric hosts, encoded dot segments, trailing-dot hosts and IPv6 literals are rejected. Network destination safety is enforced separately by verifiers. The like client uses the node's new canonical identity when safe-claim storage is present and retains the legacy byte behavior for older nodes.

`WikaPortfolioClient` discovers account-filtered ownership periods, pending replacements and unfinished verification requests from the financial GraphQL indexer. It verifies chain identity and replay start, pins cursor batches to a finalized indexed snapshot, normalizes Wika SS58 addresses and preserves exact period ids. The default browser fetch retains its required global receiver; metadata processing timestamps normalize to ISO whether the query service returns milliseconds, numeric strings or ISO text. Invalid/missing times remain unavailable. Discovery records are hints; read node state through `claims.getPage` / `getPeriod` before displaying balances and use normal quotes/submissions for actions. `claims.getFinalizedHeight()` supplies the snapshot cap. The owners example implements pagination, lag labels and node confirmation.

The complete release still needs the remaining Linux/AMD64 integration, benchmarking and production configuration/review. Automatic portfolio discovery in the native extension remains future work. The node's old marker claim call is disabled on runtime 402.
