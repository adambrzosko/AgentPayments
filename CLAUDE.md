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
- `django_deployment/`: Django integration demo.
- `netlify_deployment/`: Netlify deployment files.
- `cloudflare_deployment/`: Cloudflare Worker integration demo.
- `nodejs_deployment/`: Node/Express integration demo.
- `scripts/`: Demo and verification scripts.

## Expectations
- Keep diffs focused and avoid unrelated refactors.
- Follow existing code style and structure.
- Avoid destructive git/file operations unless explicitly requested.
- Do not add secrets, keys, or sensitive values to tracked files.

## Verification
- After Django edits, run:
  - `python django_deployment/manage.py check`
- After Cloudflare integration changes, run:
  - `npx wrangler deploy` from `cloudflare_deployment/` when requested
- If behavior changed, add or update a small test where practical.
- Report any command you could not run and why.

## Handoff Format
- Summarize:
  - Files changed
  - Behavior impact
  - Validation performed
  - Known gaps
