# AGENTS.md

## Scope
This file defines how coding agents should work in this repository.

## Project Layout
- `django_deployment/`: Primary Django implementation (source of truth).
- `netlify_deployment/`: Static + Netlify edge deployment variant.
- `scripts/`: Utility and demo scripts.
- Root scripts: `setup_wallet.py`, `bot_visitor.py`.
- `nodejs_deployment/`: Node/Express demo deployment.

## Working Rules
- Make minimal, targeted changes.
- Prefer `django_deployment/` for Django server changes.
- Do not move or delete deployment folders without explicit instruction.
- Never commit secrets or private keys.
- Keep edits ASCII unless file already requires Unicode.
- Preserve existing style and naming.

## Validation
- For Django changes, run:
  - `python django_deployment/manage.py check`
- For script changes, run only the affected script with safe/local settings.
- If tests are added later, run the smallest relevant subset first.

## Change Notes
- In PR or handoff summaries, include:
  - What changed
  - Why it changed
  - What was run to validate
  - Any remaining risks or follow-ups
