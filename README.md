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
- `nodejs_deployment/`: Express integration demo.
- `django_deployment/`: Django integration demo.
- `netlify_deployment/`: Netlify variant.

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
