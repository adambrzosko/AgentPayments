# @agentpayments/edge (local SDK package)

Shared fetch-runtime gate for edge platforms.

## Includes adapters
- `./cloudflare` -> `createAgentPaymentsWorker()`
- `./netlify` -> `createNetlifyGate()`
- `./vercel` -> `createVercelEdgeGate()`

## Goal
One core edge gate behavior, thin host adapters.

## Example (Cloudflare)
```js
import { createAgentPaymentsWorker } from '@agentpayments/edge/cloudflare';

export default createAgentPaymentsWorker({
  assetsBinding: 'ASSETS',
});
```

## Example (Netlify)
```ts
import { createNetlifyGate } from '@agentpayments/edge/netlify';

export default createNetlifyGate();
```

## Example (Vercel)
```ts
import { NextResponse } from 'next/server';
import { createVercelEdgeGate } from '@agentpayments/edge/vercel';

const gate = createVercelEdgeGate({
  env: {
    CHALLENGE_SECRET: process.env.CHALLENGE_SECRET,
    AGENTPAYMENTS_VERIFY_URL: process.env.AGENTPAYMENTS_VERIFY_URL,
    AGENTPAYMENTS_API_KEY: process.env.AGENTPAYMENTS_API_KEY,
  },
  upstreamNext: () => NextResponse.next(),
});

export default gate;
```

## Environment variables
- `CHALLENGE_SECRET` — HMAC secret for signing agent keys and cookies
- `AGENTPAYMENTS_VERIFY_URL` — URL of the verify service
- `AGENTPAYMENTS_API_KEY` — Per-merchant API key

Wallet address and network are fetched automatically from the verify service.
