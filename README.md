# AgentPayments

## Deployments
There are three separate test deployments (nodejs, django, netlify/typescript).
These will be used to test implementation of the bot blocking via a library import across common web architectures.

For Oracle Always Free VM deployment of the Django app, see `django_deployment/DEPLOY_ORACLE.md`.


## JSON Files
- `.test-keypair.json`: Local devnet Solana keypair used by `test_payment.py` and `demo.py` as a persistent payer wallet. Safe
  to delete; scripts will recreate it.
- `bot-wallet.json`: Wallet data used by the bot visitor script (`bot_visitor.py`).
- `wallet-keys.json`: Generated wallet keys used by local scripts (created by `setup_wallet.py`).
- `netlify_deployment/.well-known/agent-access.json`: Public discovery file served at `/.well-known/agent-access.json` for the
  Netlify demo site.
- `django_deployment/.well-known/agent-access.json`: Same discovery file for the Django demo site.
