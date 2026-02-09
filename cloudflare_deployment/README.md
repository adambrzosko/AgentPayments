# Cloudflare Deployment

Cloudflare Workers + static assets deployment demo for AgentPayments.

## Integration model
This folder is intentionally thin.
Core gate logic is imported from `../sdk/cloudflare-gate.js`.

That keeps this deployment Stripe-style: small wrapper + config, with shared logic centralized.

## Files
- `wrangler.toml`: Worker config + static asset binding.
- `src/worker.js`: Thin wrapper that imports shared gate logic.
- `../sdk/cloudflare-gate.js`: Shared Cloudflare gate implementation.
- `public/`: Static site files served via Workers Assets.

## Local Dev
1. Install dependencies:
   - `npm install`
2. In this folder, set secrets/vars:
   - `wrangler secret put CHALLENGE_SECRET`
   - `wrangler secret put HOME_WALLET_ADDRESS`
   - Optional vars: `SOLANA_RPC_URL`, `USDC_MINT`, `DEBUG`
3. Run locally:
   - `npm run dev`

## Deploy
- `npm run deploy`

## Notes
- Public paths bypass gate:
  - `/robots.txt`
  - `/.well-known/agent-access.json`
- `wrangler.toml` uses `run_worker_first = true` so gate logic runs before static assets.
