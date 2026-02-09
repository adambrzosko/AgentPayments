# AgentPayments

Stripe-style goal: vendors should install/import our package and add only a couple of lines to protect routes.

## Architecture direction (important)
- Bot-blocking/payment logic should live in shared package-style code (`sdk/` now, publishable package next).
- Deployment folders are integration demos only.
- Deployment folders should contain minimal wiring/config (import + a few lines), not duplicated gate logic.

## Deployments
There are three separate test deployments (nodejs, django, netlify/typescript + cloudflare).
These exist to prove the same shared gate can be integrated across common web architectures.

- `cloudflare_deployment/`: Worker wrapper + static assets.
- `django_deployment/`: Django wrapper + demo static files.
- `netlify_deployment/`: Netlify edge wrapper + demo static files.
- `nodejs_deployment/`: Express integration demo (thin wrapper over `@agentpayments/node` local package).
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

## Django (Oracle)
For Oracle Always Free VM deployment of the Django app, see `django_deployment/DEPLOY_ORACLE.md`.

Site is accessible via public endpoint http://140.238.68.134

## JSON Files
- `.test-keypair.json`: Local devnet Solana keypair used by `test_payment.py` and `demo.py` as a persistent payer wallet. Safe
  to delete; scripts will recreate it.
- `bot-wallet.json`: Wallet data used by the bot visitor script (`bot_visitor.py`).
- `wallet-keys.json`: Generated wallet keys used by local scripts (created by `setup_wallet.py`).
- `netlify_deployment/.well-known/agent-access.json`: Public discovery file served at `/.well-known/agent-access.json` for the
  Netlify demo site.
- `django_deployment/.well-known/agent-access.json`: Same discovery file for the Django demo site.
