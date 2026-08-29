# @agentpayments/node

Express-first AgentPayments middleware. Blocks bots and gates access behind Solana USDC payments.

## Install

```bash
npm install @agentpayments/node
# or, in this monorepo:
# npm install file:../sdk/node
```

## Usage

```js
const express = require('express');
const { agentPaymentsGate } = require('@agentpayments/node');

const app = express();
app.use(express.urlencoded({ extended: false }));

app.use(agentPaymentsGate({
  challengeSecret: process.env.CHALLENGE_SECRET,
  homeWalletAddress: process.env.HOME_WALLET_ADDRESS,
}));

app.get('/', (req, res) => res.send('Hello, verified visitor!'));
app.listen(3000);
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `challengeSecret` | `string` | `'default-secret-change-me'` | HMAC secret for signing cookies, nonces, and agent keys. **Required in production.** |
| `homeWalletAddress` | `string` | `''` | Solana wallet address to receive USDC payments. |
| `solanaRpcUrl` | `string` | Auto (devnet/mainnet) | Custom Solana RPC endpoint. |
| `usdcMint` | `string` | Auto (devnet/mainnet) | Custom USDC mint address. |
| `minPayment` | `number` | `0.01` | Minimum USDC payment required. Ignored when `pricingTiers` is set (the lowest tier's `minAmount` becomes the floor). |
| `accessDuration` | `number \| null` | `null` (forever) | Seconds a successful payment grants access for. Requires a `grantStore` to actually persist — see **Pricing & Access Model** below. |
| `pricingTiers` | `array \| null` | `null` | Payment-amount → access mapping: `[{ minAmount, durationSeconds, name }]`. Overrides `minPayment`/`accessDuration`. |
| `routes` | `array \| null` | `null` | Per-route overrides for a single gate instance: `[{ pathPrefix, minPayment, accessDuration, pricingTiers }]`, matched by longest `pathPrefix`. |
| `debug` | `boolean` | `process.env.DEBUG !== 'false'` | `true` = devnet + warnings. `false` = mainnet + strict. |
| `apiKey` | `string` | none | AgentPayments hosted-platform API key (`ap_live_...`). When set, agent keys are issued and metered via the platform instead of self-signed locally. See **Hosted Platform Mode** below. |
| `platformApiUrl` | `string` | AgentPayments-hosted URL | Override for a self-hosted platform API. |

## Environment Variables

| Variable | Maps to |
|---|---|
| `CHALLENGE_SECRET` | `challengeSecret` |
| `HOME_WALLET_ADDRESS` | `homeWalletAddress` |
| `SOLANA_RPC_URL` | `solanaRpcUrl` |
| `USDC_MINT` | `usdcMint` |
| `DEBUG` | `debug` |
| `AGENTPAYMENTS_API_KEY` | `apiKey` |
| `AGENTPAYMENTS_PLATFORM_URL` | `platformApiUrl` |

## Hosted Platform Mode

Setting `apiKey` switches agent-key issuance from local (`ag_...`) to platform-issued (`agp_...`), and — when the platform account has an on-chain fee configured — every 402 response's `payment` object gains a `platform_fee` field:

```json
"payment": {
  "chain": "solana", "network": "devnet", "token": "USDC",
  "amount": "0.01", "wallet_address": "<vendor wallet>", "memo": "agp_...",
  "platform_fee": {
    "wallet_address": "<platform fee wallet>",
    "amount": "0.0002",
    "rate_pct": 2,
    "note": "Must be a second USDC transfer inside the SAME Solana transaction as the payment above, or access will be denied."
  }
}
```

The agent must send **both transfers in one Solana transaction** — the vendor payment and the platform fee — or the gate denies access exactly as it would for an unpaid key. This field is only ever present in hosted-platform mode with a fee configured; it's absent for self-hosted deployments (no `apiKey`), which are completely unaffected. It's deliberately not part of the standards-compliant `accepts[]`/`X-PAYMENT-REQUIRED` x402 fields — those still describe only the vendor leg, so generic x402 clients aren't misled into thinking they can pay either destination.

## Pricing & Access Model

By default one `minPayment` buys indefinite access. Three options layer on top of that, Stripe-style — simple case first, escape hatch for complexity:

```js
app.use(agentPaymentsGate({
  ...config,
  grantStore: new FileGrantStore('./data/grants.json'), // required for duration/tiers to persist
  accessDuration: 86400, // seconds; a paid key is only good for 24h, then re-verifies
}));
```

**`pricingTiers`** lets a higher payment buy longer (or unlimited) access instead of a single flat duration:

```js
pricingTiers: [
  { minAmount: 0.01, durationSeconds: 3600,  name: 'hourly' },
  { minAmount: 0.05, durationSeconds: 86400, name: 'daily' },
  { minAmount: 0.50, durationSeconds: null,  name: 'lifetime' },
],
```

The gate finds the highest tier the actual on-chain payment clears and grants that tier's duration. `minPayment` is ignored when `pricingTiers` is set — the lowest tier's `minAmount` becomes the floor price required for any access at all. Every non-floor tier also appears as its own entry in the 402 response's x402 `accepts[]` array (with a non-standard `tier`/`durationSeconds` hint in `extra`), so an agent can compare price/duration tradeoffs upfront instead of only ever seeing the floor price.

**`routes`** applies different pricing to different paths from a single gate instance — useful when you don't want to mount a separate `agentPaymentsGate(...)` per route:

```js
routes: [
  { pathPrefix: '/api/premium', minPayment: 0.05 },
  { pathPrefix: '/api/basic',   minPayment: 0.01 },
],
```

Matched by longest `pathPrefix` on a path-segment boundary (`/premium` matches `/premium/data` but not `/premium-lookalike`); requests that match no entry fall back to the gate's top-level `minPayment`/`accessDuration`/`pricingTiers`.

**Revocation**: the built-in `MemoryGrantStore`/`FileGrantStore` (`sdk/node/grant-store.js`) both got a `revoke(agentKey)` method — call it from your own admin route to cut off a specific paid key early. The gate itself needs no changes to respect this: `has()` already returns `false` for a revoked (or expired) grant. A grants file written by an older SDK version (a plain JSON array of key strings) is still read correctly as a set of permanent grants — upgrading doesn't invalidate existing data.

## Security Features

- **Timing-safe HMAC comparison** — uses `crypto.timingSafeEqual` for all signature checks
- **Payment verification cache** — 10-minute TTL, 1000-entry max, avoids redundant RPC calls
- **Rate limiting** — 20 challenge verifications per minute per IP
- **Input size limits** — key (64 chars), nonce (128), return URL (2048), fingerprint (128)
- **Wallet address validation** — base58 format, 32-44 chars, validated at init
- **Default secret detection** — warns in debug, throws in production
- **Structured JSON logging** — all gate events logged as JSON with timestamps

## How It Works

1. **Public paths** (`/robots.txt`, `/.well-known/*`) bypass the gate.
2. **Browser visitors** (detected via `Sec-Fetch-Mode`/`Sec-Fetch-Dest` headers) receive a JavaScript challenge page. Passing the challenge sets a signed `__agp_verified` cookie (24h TTL).
3. **API clients** without browser headers get a `402` response with an agent key. After paying, they include `X-Agent-Key: <key>` to access resources.

## Response Schema

See [API Reference](../../API_REFERENCE.md) for full 402/403/429 response formats.

## TypeScript

TypeScript types are included via `index.d.ts`. The package exports:

```ts
import type { AgentPaymentsGateConfig } from '@agentpayments/node';
import { agentPaymentsGate } from '@agentpayments/node';
```

## Notes
- CommonJS module (`require()`).
- Constants loaded from `sdk/constants.json`.
- Next wrappers planned: Fastify and Koa (same core behavior).
