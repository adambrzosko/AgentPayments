# AgentPayments

Stripe-style goal: a website owner installs/imports one package, adds a few lines, and agent access is automatically gated behind payment.

## Architecture
- Core gate behavior lives in `sdk/` (shared, package-style code).
- Deployment folders are thin wrappers only (minimal wiring and config).
- Verification is done by `verify_service/` (not by deployment wrappers).
- `verify_service` and `llm_wallet_hub` are entirely separate services with separate UIs/deployments.
- `llm_wallet_hub/` is separate software for user wallets and tool-based payments.

## Public URLs

### Gated website demos
- Edge (Cloudflare Worker): https://agentpayments-cloudflare.matthew-newell.workers.dev
- Python (Django, Oracle VM): https://clankertax.tearsheet.one
- Node (Express behind nginx path): https://clankertax.tearsheet.one/node/
- Next.js (Vercel alias): https://nextjsdeployment-five.vercel.app


- Next.js (direct Vercel deployment): https://nextjsdeployment-h3sqvhkx0-matt-newells-projects.vercel.app
- Node direct subdomain (if DNS active): https://node.clankertax.tearsheet.one
- Django direct IP HTTP: http://140.238.68.134

### Verify Service (separate service)
- Verify service UI/base URL: https://verifyservice-omega.vercel.app
- Verify endpoint used by SDKs: `https://verifyservice-omega.vercel.app/verify`
- Merchant signup endpoint: `https://verifyservice-omega.vercel.app/merchants/signup`
- Merchant metadata endpoint: `https://verifyservice-omega.vercel.app/merchants/me`

### Wallet Hub (separate service)
- Wallet hub UI/API (LLM wallet hub deployment): https://llmwallethub.vercel.app

### On-chain wallet and network
- Current configured recipient wallet address: `5rXZeAEbg13DQnSFijEno2hKEJLK2p14fAo3AmPtfBft`
- Solana RPC currently configured in local env: `https://api.mainnet-beta.solana.com`
- Token: USDC SPL token (network-specific mint handled by verifier)

## Verification flow (agent request to on-chain confirmation)
1. Agent request hits a protected route without `X-Agent-Key`.
2. Gate returns HTTP `402 payment_required` with:
   - a newly generated key (`ag_...`)
   - payment instructions
   - deterministic memo (`gm_...`) derived from that key
3. Agent sends USDC on Solana with that memo.
4. Agent retries with `X-Agent-Key: <ag_key>`.
5. Gate calls verify backend `GET /verify?memo=<gm_...>` with merchant Bearer key.
6. Verify backend checks cache table `verified_payments`.
7. If not cached, verify backend scans recent Solana transactions for:
   - matching memo
   - USDC transfer meeting minimum amount
   - recipient wallet match
8. On match, backend stores verification and returns `{ "paid": true }`.
9. Gate caches paid status and allows upstream request.

## Website onboarding flow (merchant)
1. Merchant opens verify service signup page (served by `verify_service/public/index.html`).
2. Merchant submits site name/URL to `POST /merchants/signup`.
3. Verify service returns a per-merchant API key.
4. Merchant adds env vars to their site:
   - `CHALLENGE_SECRET=<strong-random-secret>`
   - `AGENTPAYMENTS_VERIFY_URL=<VERIFY_BASE_URL>/verify` (or base URL; SDK appends `/verify`)
   - `AGENTPAYMENTS_API_KEY=<merchant-api-key>`
5. Merchant installs and wires the platform package:
   - Node/Express: `@agentpayments/node`
   - Edge runtimes: `@agentpayments/edge`
   - Python: `agentpayments-python`
   - Next.js middleware: `@agentpayments/next`
6. Site deploys with gate middleware enabled.
7. First agent request receives payment instructions automatically.
8. After payment confirms, same key unlocks future requests (subject to cache TTL and policy).

## Project layout
- `sdk/node/`: Implementation #1 (`@agentpayments/node`)
- `sdk/edge/`: Implementation #2 (`@agentpayments/edge`)
- `sdk/python/`: Implementation #3 (`agentpayments-python`)
- `sdk/next/`: Implementation #4 (`@agentpayments/next`)
- `verify_service/`: verification backend, merchant API key issuance, on-chain scanning
- `llm_wallet_hub/`: separate wallet platform and tool-payment API
- `node_implementation/`: thin Express demo wrapper
- `next_implementation/`: thin Next.js demo wrapper
- `edge_implementation/cloudflare_worker/`: thin Cloudflare wrapper
- `edge_implementation/netlify/`: thin Netlify wrapper
- `python_implementation/django/`: thin Django wrapper

## SDK roadmap
1. `@agentpayments/node` complete
2. `@agentpayments/edge` complete
3. `agentpayments-python` complete
4. `@agentpayments/next` complete
5. Proxy adapter (Nginx/Envoy style) next

## Deployment notes
- Django Oracle deployment doc: `python_implementation/django/DEPLOY_ORACLE.md`
- Keep deployment wrappers thin; move behavior changes into `sdk/`.
- Never commit secrets or private keys.

## Important files
- `verify_service/app.js`: verification API and merchant endpoints
- `verify_service/chain.js`: on-chain Solana USDC memo verification logic
- `sdk/node/index.js`: Node middleware gate logic
- `sdk/edge/index.js`: shared edge gate logic used by Cloudflare/Netlify/Vercel/Next wrapper
- `sdk/next/index.js`: Next middleware adapter over edge gate
