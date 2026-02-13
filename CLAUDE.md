# CLAUDE.md

## Scope
Instructions for Claude-based coding agents working in this repo.

## Product Intent
Treat this as a Stripe-style developer product.

Target developer experience:
1. Install/import AgentPayments package
2. Add a couple of lines in app bootstrap/middleware
3. Ship

Therefore:
- Shared gate logic belongs in central package-style code (`sdk/` for now).
- Deployment folders should only contain integration glue, config, and demo assets.
- Do not duplicate or fork core gate logic inside deployment folders unless explicitly asked.

## Repo Map
- `sdk/`: Shared AgentPayments gate implementation (source of truth for shared behavior).
  - `sdk/node/`: **Implementation #1 complete** (`@agentpayments/node`, Express-first).
  - `sdk/edge/`: **Implementation #2 complete** (`@agentpayments/edge`, Cloudflare/Netlify/Vercel adapters).
  - `sdk/python/`: **Implementation #3 complete** (`agentpayments-python`, Django/FastAPI/Flask adapters).
  - `sdk/next/`: **Implementation #4 complete** (`@agentpayments/next`, middleware wrapper).
  - Planned: proxy adapter.
- `python_implementation/django/`: Django integration demo.
- `edge_implementation/netlify/`: Netlify deployment files.
- `edge_implementation/cloudflare_worker/`: Cloudflare Worker integration demo.
- `node_implementation/`: Node/Express integration demo.
- `verify_service/`: Standalone payment verification backend (own Postgres DB, per-merchant API keys, on-chain Solana checks).
- `scripts/`: Demo and verification scripts.

## Expectations
- Keep diffs focused and avoid unrelated refactors.
- Follow existing code style and structure.
- Avoid destructive git/file operations unless explicitly requested.
- Do not add secrets, keys, or sensitive values to tracked files.

## Testing
After meaningful changes, run the relevant test suite:
- Node SDK: `cd sdk/node && npm test`
- Edge SDK: `cd sdk/edge && npm test`
- Python SDK: `cd sdk/python && python -m pytest tests/`
- Verify service: `cd verify_service && npm test`
- Node demo: `cd node_implementation && npm test`
- Django demo: `cd python_implementation/django && python manage.py test gate`
- Wallet hub: `cd llm_wallet_hub && npm test`

## Verification
- After Django edits, run:
  - `python python_implementation/django/manage.py check`
- After Cloudflare integration changes, run:
  - `npx wrangler deploy` from `edge_implementation/cloudflare_worker/` when requested
- If behavior changed, add or update a small test where practical.
- Report any command you could not run and why.

## Handoff Format
- Summarize:
  - Files changed
  - Behavior impact
  - Validation performed
  - Known gaps
