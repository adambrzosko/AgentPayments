# Cloudflare Deployment

Cloudflare Workers + static assets deployment for the AgentPayments gate.

## Files
- `wrangler.toml`: Worker config + static asset binding.
- `src/worker.js`: Gate middleware logic (ported from Netlify edge function).
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
- `netlify_deployment/` is left unchanged.
- Public paths bypass gate:
  - `/robots.txt`
  - `/.well-known/agent-access.json`
