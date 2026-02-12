# AgentPayments

Stripe-style goal: vendors should install/import our package and add only a couple of lines to protect routes.

## Architecture direction (important)
- Bot-blocking/payment logic should live in shared package-style code (`sdk/` now, publishable package next).
- Deployment folders are integration demos only.
- Deployment folders should contain minimal wiring/config (import + a few lines), not duplicated gate logic.

## Verification Service
- `verify_service/`: Standalone payment verification backend. Watches the Solana blockchain directly for USDC payments. Each merchant gets their own scoped API key. SDKs call this service (not llm_wallet_hub) to verify agent payments.

## Deployments
These exist to prove the same shared gate can be integrated across common web architectures with thin per-platform wrappers.

- `edge_implementation/cloudflare_worker/`: Worker wrapper + static assets.
- `python_implementation/django/`: Django wrapper + demo static files.
- `edge_implementation/netlify/`: Netlify edge wrapper + demo static files.
- `node_implementation/`: Express integration demo (thin wrapper over `@agentpayments/node` local package).
- `next_implementation/`: Next.js integration demo (thin wrapper over `@agentpayments/next`).
- `sdk/`: Shared gate logic used by deployment wrappers (JS/TS + Python).
  - `sdk/node/`: **Implementation #1 complete** (`@agentpayments/node`, Express-first).
  - `sdk/edge/`: **Implementation #2 complete** (`@agentpayments/edge`, Cloudflare/Netlify/Vercel adapters).
  - `sdk/python/`: **Implementation #3 complete** (`agentpayments-python`, Django/FastAPI/Flask adapters).
  - `sdk/next/`: **Implementation #4 complete** (`@agentpayments/next`, middleware wrapper for Next.js).

## SDK roadmap (keep this clear)
1. ✅ `@agentpayments/node` (Express middleware; first shipping target)
2. ✅ `@agentpayments/edge` (shared fetch runtime + Cloudflare/Netlify/Vercel adapters)
3. ✅ `agentpayments-python` (Django/FastAPI/Flask adapters)
4. ✅ `@agentpayments/next` (first-class Next.js middleware wrapper)
5. ⏳ Proxy adapter (Nginx/Envoy style enforcement)

Rule: deployment folders stay thin; core gate behavior belongs in `sdk/` packages.

## Public demo URLs
- **Edge implementation (Cloudflare Worker)**: https://agentpayments-cloudflare.matthew-newell.workers.dev
- **Python implementation (Django on Oracle VM, HTTPS)**: https://clankertax.tearsheet.one
- **Node.js implementation (Oracle VM via nginx path)**: https://clankertax.tearsheet.one/node/
- **Next.js implementation (Vercel alias)**: https://nextjsdeployment-five.vercel.app

Also, in case needed:
- **Django Oracle VM, direct IP HTTP**: http://140.238.68.134
- **Node.js direct subdomain (DNS may still propagate)**: https://node.clankertax.tearsheet.one
- **Next.js Vercel deployment URL**: https://nextjsdeployment-h3sqvhkx0-matt-newells-projects.vercel.app


## Django (Oracle)
For Oracle Always Free VM deployment of the Django app, see `python_implementation/django/DEPLOY_ORACLE.md`.

## JSON Files
- `.test-keypair.json`: Local devnet Solana keypair used by `test_payment.py` and `demo.py` as a persistent payer wallet. Safe
  to delete; scripts will recreate it.
- `bot-wallet.json`: Wallet data used by the bot visitor script (`bot_visitor.py`).
- `wallet-keys.json`: Generated wallet keys used by local scripts (created by `setup_wallet.py`).
- `edge_implementation/netlify/.well-known/agent-access.json`: Public discovery file served at `/.well-known/agent-access.json` for the
  Netlify demo site.
- `python_implementation/django/.well-known/agent-access.json`: Same discovery file for the Django demo site.
