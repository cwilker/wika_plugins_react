# Wika web libraries

Reusable paid Like buttons for Wika Node 4.x. This replaces the old standalone React prototype with two TypeScript packages:

- **`@wika/core`** — framework-independent chain reads, live page subscriptions, exact token amounts, fee quotes, finalized transaction monitoring, and a browser wallet adapter.
- **`@wika/react`** — a reusable `WikaLike` component with account selection, cost preview, wallet approval, and transaction progress.
- **`examples/demo`** — a small website using both packages.

The core has no React or DOM requirement for chain operations. Browser wallet access happens only when the user chooses to connect. Neither package holds private keys. The wallet authorizes and signs transactions.

## Run locally

Use Node **22.12+ (22.x), 24.x, or 26+** and npm. From this repository:

```sh
npm ci
npm run check
npm run dev
```

Open **http://127.0.0.1:3015**. By default the demo connects to **ws://127.0.0.1:9944**. Start a development node in another terminal, from the sibling node repository:

```sh
cd ../wika_node
./target/release/wika-node --dev --tmp
```

Configure the demo by copying `examples/demo/.env.example` to `examples/demo/.env.local`. Set `VITE_WIKA_NODE_URL`, `VITE_WIKA_PAGE_URL`, and optionally `VITE_WIKA_GENESIS_HASH`. HTTPS sites require a secure `wss://` endpoint. The dev server binds only to loopback.

Load and unlock your Wika wallet, select the same network in the wallet, and authorize the demo when prompted. Choose a funded account for that network. On a development chain, use a development account you have explicitly imported into your wallet. Never use development keys on a public network.

For the UI flow: open **Like with Wika**, connect the wallet, select an account, review the count and estimated total, then approve in the wallet. The dialog shows success only after finalized execution succeeds. An account currently in a URL's reward queue cannot like that URL again; that restriction comes from the node.

## React integration

The packages are built locally and have **not been published to npm**. npm workspaces link them in this repository. To use them in another project before publication, run `npm run build`, then `npm pack -w @wika/core` and `npm pack -w @wika/react`; install both generated tarballs in the consumer.

```tsx
import { WikaClient } from "@wika/core";
import { WikaLike } from "@wika/react";
import "@wika/react/styles.css";

// Initialize once in your app's client-side connection lifecycle.
const client = await WikaClient.connect({
  endpoint: "ws://127.0.0.1:9944",
  // genesisHash: '0x…', // Recommended when targeting a particular deployed chain.
});

function ArticleActions() {
  return (
    <WikaLike
      client={client}
      url="https://example.org/article"
      referrerUrl="https://example.org/collection"
      appName="Example publisher"
      onSuccess={(receipt) => console.log(receipt.txHash)}
      onError={(error) => console.error(error.message)}
    />
  );
}

// After unmounting all consumers:
// await client.disconnect();
```

Pass a stable `client` and, if supplied, a stable `wallet` object. Multiple buttons can share the same connection and wallet. The component releases its own page/account subscriptions on unmount; the application owns the connection. The included demo illustrates effect cleanup with React Strict Mode.

The component can be server-rendered with a supplied client contract; open WebSocket connections on the client. It supports React 18 and declares React 19 compatibility through its peer range; automated UI tests currently run on React 18. Native `<dialog>` provides focus containment, Escape dismissal, and focus restoration in modern browsers. CSS is optional and scoped under `.wika-like`; import it once or provide your own styles.

### Props

| Prop                    | Purpose                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `client`                | Required `WikaClientLike` implementation; typically a shared `WikaClient`.                              |
| `url`                   | Required exact HTTP(S) URL to like.                                                                     |
| `referrerUrl`           | Optional URL credited as referrer; defaults to the empty byte string.                                   |
| `wallet`                | Optional `WalletAdapter`; defaults to the injected Wika wallet.                                         |
| `appName`               | Name shown during wallet authorization.                                                                 |
| `label`                 | Button/dialog label; defaults to `Like with Wika`.                                                      |
| `disabled`, `className` | Host application presentation controls.                                                                 |
| `onSuccess`, `onError`  | Finalized receipt and connection/signing operation error callbacks. Read/quote errors are shown inline. |

## Core without React

```ts
import { WikaClient, createInjectedWallet, formatAmount } from "@wika/core";

const client = await WikaClient.connect({ endpoint: "ws://127.0.0.1:9944" });
const network = await client.getNetwork();
const wallet = createInjectedWallet();

// Run wallet authorization from a user action, not on page load.
const accounts = await wallet.connect("Example publisher");
const account = accounts.find(
  (a) => !a.genesisHash || a.genesisHash === network.genesisHash,
);
if (!account) throw new Error("Authorize an account for this network.");
const request = { url: "https://example.org/article", count: 2 };
const quote = await client.quoteLike(account.address, request);
console.log(formatAmount(quote.total, network.decimals, network.symbol));
if (!quote.affordable) throw new Error("Insufficient spendable balance.");

const stop = await client.subscribePage(
  request.url,
  account.address,
  (page) => {
    console.log(page.likes.toString(), page.mine);
  },
  (error) => console.error(error),
);

try {
  const signer = await wallet.getSigner(account);
  const receipt = await client.submitLike(account, signer, request, {
    onStatus: (status) => console.log(status),
    timeoutMs: 120000,
  });
  console.log(receipt);
} finally {
  stop();
  await client.disconnect();
}
```

`getPage(url, address?)` reads counts, owner, and optional queue membership. `getBalance(address)` exposes free/frozen balances and a conservative spendable amount. `quoteLike` reads the chain's current price and maximum count, checks queue membership, and estimates the fee. `submitLike` rechecks the quote and account genesis before requesting a signature. `WikaClient.fromApi(api)` wraps an existing ready Polkadot connection and does not close it when `disconnect()` is called.

Amounts are `bigint` in base units; use `formatAmount` or `.toString()` for presentation/JSON. The core supports current `OptionQuery` storage and decodes legacy unwrapped tuples. Transaction failures use metadata-derived pallet names and documentation.

### Wallet boundary

`WalletAdapter` exposes `connect(appName)`, `getSigner(account)`, and an optional `subscribeAccounts(callback)`. Implement this interface for a mobile wallet, hardware signer, or another platform. `createInjectedWallet()` uses `window.injectedWeb3.wika`; pass `{ sources: ['wika', 'polkadot-js'] }` to permit additional installed providers. Requested providers may each prompt for authorization.

The adapter forwards account subscriptions when the provider supports them. The current Wika extension's injected account subscription emits an initial snapshot; use **Refresh wallet accounts** after changing accounts in the extension. Account authorization is checked again before obtaining its signer.

### URL identity and referrals

The chain keys storage by **exact URL bytes**. The libraries validate HTTP(S) URLs and Wika 4.x's limit of fewer than 255 UTF-8 bytes, but never silently strip fragments, rewrite paths, or normalize query strings. Choose the same URL identity used by your site and wallet. The React component never infers its target from its hosting frame's location. Referrer credit is explicit through `referrerUrl`; automatic navigation attribution is outside this release.

### Transaction lifecycle

Progress is `signing → submitted → inBlock → finalized`, with `retracted` for an inclusion removed by a fork. Inclusion alone does not imply success. The promise resolves only with a finalized `system.ExtrinsicSuccess`; dispatch failures and invalid/dropped/usurped transactions reject. Monitoring unsubscribes on completion, timeout, or abort, including when the unsubscribe handle arrives late.

An `AbortSignal` stops local monitoring. **It cannot cancel a signature request or undo a transaction already broadcast.** Closing the dialog keeps monitoring active; unmounting stops monitoring. After a timeout, cancellation, or lost connection, check your wallet/chain before retrying.

Quotes are estimates and can change before execution. Spendable balance conservatively retains the larger of the existential deposit and freezes. The node remains authoritative for fees, locks, and queue eligibility.

## Validation

```sh
npm run typecheck
npm test
npm run build
```

The default tests cover SCALE storage decoding, exact amounts, validation, pricing, wallet protocol/authorization, finality/errors/retractions, abort/timeout cleanup, and component interactions. The live test skips unless explicitly enabled:

```sh
# Development chain only. Sends two likes from //Alice, using a unique test URL.
WIKA_NODE_URL=ws://127.0.0.1:9944 npm run test:live
```

The live test exercises connection, chain properties, subscriptions, fee estimates, a wallet-shaped signer, finalized execution, updated queue membership, and a mismatched genesis hash. It does not automate the installed browser extension's approval UI. CI runs typechecking, unit/component tests, and all builds.

## Scope

This release provides the shared core and React Like component. It does not require the ETL. Indexed history/discovery can be added separately through the ETL's GraphQL API. Ownership registration UI, a plain HTML custom element, WordPress/Shopify wrappers, and mobile wallet transports are future adapters/features rather than dependencies of this implementation.

## Node compatibility checks

This repository declares its node requirements in `compatibility/node-contract.json` (at the repository root). The accompanying `suite.json` defines its build, regression, and live behavior checks. Node changes are tested against these requirements in the node CI consumer matrix; this repository's `Node compatibility` workflow also tests consumer changes against its configured node revision.

From the package directory, with an isolated development node running:

```sh
WIKA_NODE_URL=ws://127.0.0.1:9944 npm run test:compatibility
```

Install dependencies in the sibling `wika_node/compatibility` directory first. Set `WIKA_NODE_CHECKOUT` if the node checkout is elsewhere. This command fails when required configuration is missing; live checks cannot silently skip. Reports go to `compatibility/reports` at the repository root. The node's [compatibility guide](https://github.com/randombishop/wika_node/blob/polkadot-sdk-upgrade/compatibility/README.md) documents the full local runner, supported contracts, and the initial cross-repository CI rollout. The workflow files must be committed and pushed to the configured refs before remote checks become active.

## Owners dashboard preview

Run `npm run dev:owners` and open http://127.0.0.1:3016 for an indexed wallet portfolio and saved-page watchlist with safe-claim actions, challenge deadlines and current/historical withdrawals. Configure `VITE_WIKA_INDEXER_URL` or enter the financial query-service URL in the portfolio view. Discovery checks chain identity and labels indexing lag; balances and actions are confirmed against the node. See [owners preview setup and scope](examples/owners/README.md). A future separate monitoring app is planned for page owners, node operators, validators and claim verifiers.


Safe-claim release checks also run `compatibility/claims.mjs` against the candidate development node, including verifier restart, refresh, cooperative replacement and historical withdrawals. Install the sibling node's `verifier` dependencies alongside its compatibility checker. `WikaClaimsApi` is the structural transport boundary for the claim UI; the native extension implements it over trusted background messages so keys stay outside the popup.


## Signed host referrals (runtime 403)

Use `client.referrals.authorize(account, signer, source, publicKey)` from the current verified owning wallet. `keys(source)` reports bounded stored authorizations and current eligibility; `revoke(...)` removes a generation. The owners example includes these controls. Host keys sign requests and cannot spend funds.

On the server, `createReferralIssuer(api, {source, authorizationId, publicKey, sign, isOfferedTarget})` issues account-bound requests. Supply a server-held sr25519 signer, never a browser seed. The issuer obtains finalized economic terms from `ReferralApi_quote`, signs their SCALE commitment, limits short-lived issuance state and supports idempotent operation IDs. Add the HTTP origin, body, network and rate controls demonstrated by Discovery's server.

Pass its envelope as `LikeRequest.referral`, or provide `WikaLike.getReferral(payer,target,count)`. Set `fixedCount={1}` for a single paid endorsement. `referrerUrl` is deprecated; after activation the runtime rejects nonempty unsigned referrals with `SignedReferralRequired`. Direct requests use an empty referrer.

`quoteLike` independently verifies host authority, signature, current terms, expiry and replay state. `submitLike` rechecks before signing. The official wallet additionally verifies the actual browser tab and requires a top-level document matching the source page. `/give` integrations should put target state in fragments; different queries and paths may have different identities.

Use `beforeSign`, `onSigningPayload`, `onBroadcast` and finalized receipt hooks to persist an operation before wallet approval. The React component forwards these as `onAttempt`, `onSigningPayload`, `onBroadcast`, `onSigningRejected` and `onFinalizedFailure`. An unsuccessful quote never starts a pending payment. `recoverReferral` and `recoverDirectPayment` scan finalized history in bounded batches; persist their cursor before resuming. `signingExpiry` derives the direct-payment deadline from the actual SCALE era and block number. SDK submissions use mortal 64-block eras. Never clear an uncertain payment merely because monitoring timed out.

`WIKA_NODE_URL=ws://127.0.0.1:9944 npm run test:referrals-live` requires an isolated development chain. It registers two fixture hosts, checks exact payouts, replay, idempotency, receipt recovery, unsigned cutoff, changing economic configurations and revocation. Shared golden fixtures also run in Rust and the shipped extension. These fixtures use public development signers and never authorize production keys.

## Owner-configurable page payouts

`WikaClaim` supports default/custom splits during a verified first claim, inherited locked policies and owner configuration before first payment. `client.getPageEconomics(url)` reads authoritative terms; `client.claims.quote/submit` accepts a `configure` action or a `claim` with `policy`. `policySelection` validates chain-provided bounds and binds the reviewed revision/hash. `WikaLike` commits economic terms automatically; changing terms or activation requires a fresh quote. Decay and repeat endorsements remain separate work.

Run `npm run test:economics-live` with `WIKA_NODE_URL` pointing to a fresh disposable development chain. The fixture uses public development accounts and refuses public networks. `WIKA_ECONOMICS_REPORT` chooses the JSON report destination.

Run `npm run test:economics-browser` with `WIKA_NODE_URL`, `WIKA_EXTENSION_PATH`, `WIKA_OWNERS_REVIEW_URL` (a running loopback owners Vite server), `CHROME_PATH` and `WIKA_ECONOMICS_REPORT_DIR`. This imports only a public development wallet into a temporary profile, verifies native/shared React custom claims plus inherited registration, writes screenshots/reports and removes its temporary page source/profile. Start with fresh fixture URLs; rerunning completed claims requires a fresh test chain or different URLs.

See the [implementation and activation guide](../docs/page-economics-implementation.html). No production launch allocation is embedded in the client.
