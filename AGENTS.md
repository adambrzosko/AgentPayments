# AGENTS.md

## Scope
This file defines how coding agents should work in this repository.

## Product Direction (non-negotiable)
- We are building a Stripe-style integration:
  - install/import package
  - add a couple of lines
  - bot/payment gate works
- Keep core bot-blocking/payment logic out of deployment folders.
- Put shared logic in central package-style code (`sdk/` for now).
- Deployment folders should be thin adapters/wrappers only.

## Project Layout
- `sdk/`: Shared gate logic intended to become a publishable library.
- `django_deployment/`: Django integration demo.
- `netlify_deployment/`: Static + Netlify edge deployment demo.
- `cloudflare_deployment/`: Cloudflare Worker integration demo.
- `nodejs_deployment/`: Node/Express integration demo.
- `scripts/`: Utility and demo scripts.

## Working Rules
- Make minimal, targeted changes.
- Prefer editing shared logic in `sdk/` when behavior changes are cross-platform.
- In deployment folders, avoid copying core gate logic; keep wiring/config concise.
- Do not move or delete deployment folders without explicit instruction.
- Never commit secrets or private keys.
- Keep edits ASCII unless file already requires Unicode.
- Preserve existing style and naming.

## Validation
- For Django changes, run:
  - `python django_deployment/manage.py check`
- For Cloudflare changes, run:
  - `npx wrangler deploy` from `cloudflare_deployment/` when requested
- For script changes, run only the affected script with safe/local settings.
- If tests are added later, run the smallest relevant subset first.

## Change Notes
- In PR or handoff summaries, include:
  - What changed
  - Why it changed
  - What was run to validate
  - Any remaining risks or follow-ups
