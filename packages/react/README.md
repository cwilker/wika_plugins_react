# @wika/react

Reusable `WikaLike` component for React 18/19. Supply a shared `WikaClientLike`, an explicit page URL, and optionally a wallet adapter. Import `@wika/react/styles.css` for the default scoped styles. Account access and signing require user actions; success requires finalized execution.

See the repository README for props, integration examples, and connection ownership. The initial package is available through local workspaces or `npm pack`; it has not been published.


## Page claims

```tsx
import { WikaClaim } from '@wika/react';
import '@wika/react/styles.css';

<WikaClaim client={client.claims} url="https://your-site.example/post" />
```

Requires a runtime-402 node and a message-signing wallet. The component signs the page proof, provides head-only publishing instructions, displays verification/ownership state, quotes network and verification fees and refundable bonds, and submits only after review. Owners can verify and withdraw; pending replacements expose deadlines, objections, cooperative approvals, cancellation, expiry and the candidate's final verification. Earlier earnings are never shown as belonging to the candidate.

This is a page control component, not an indexed owners portfolio. The ETL/dashboard and native extension claim/withdrawal screens are still under construction. Development verifier setup is in the node's `verifier/README.md`.
