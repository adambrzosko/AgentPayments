# @agentpayments/next (local SDK package)

First-class Next.js middleware wrapper over `@agentpayments/edge`.

## Usage (`middleware.ts`)

```ts
import { createNextMiddleware } from '@agentpayments/next';

export default createNextMiddleware({
  publicPathAllowlist: ['/favicon.ico'],
  minPayment: 0.01,
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

## Environment variables
- `CHALLENGE_SECRET`
- `AGENTPAYMENTS_VERIFY_URL`
- `AGENTPAYMENTS_API_KEY`

Wallet address and network are fetched automatically from the verify service.

## Notes
- This package is implementation #4 in the 80/20 roadmap.
- Keep framework glue here; keep core behavior in `sdk/edge`.
