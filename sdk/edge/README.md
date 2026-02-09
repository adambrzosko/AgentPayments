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
    HOME_WALLET_ADDRESS: process.env.HOME_WALLET_ADDRESS,
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
    USDC_MINT: process.env.USDC_MINT,
    DEBUG: process.env.DEBUG,
  },
  upstreamNext: () => NextResponse.next(),
});

export default gate;
```
