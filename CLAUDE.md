# CLAUDE.md

## Scope
Instructions for Claude-based coding agents working in this repo.

## Default Target
- Treat `django_deployment/` as the active Django codebase.
- Treat `nodejs_deployment/` and `netlify_deployment/` as parallel demo deployments.

## Repo Map
- `django_deployment/`: Main Django app and middleware payment gate.
- `netlify_deployment/`: Netlify deployment files.
- `nodejs_deployment/`: Node/Express demo deployment.
- `scripts/`: Demo and verification scripts.
- Root helper scripts: `setup_wallet.py`, `bot_visitor.py`.

## Expectations
- Keep diffs focused and avoid unrelated refactors.
- Follow existing code style and structure.
- Avoid destructive git/file operations unless explicitly requested.
- Do not add secrets, keys, or sensitive values to tracked files.

## Verification
- After Django edits, run:
  - `python django_deployment/manage.py check`
- If behavior changed, add or update a small test where practical.
- Report any command you could not run and why.

## Handoff Format
- Summarize:
  - Files changed
  - Behavior impact
  - Validation performed
  - Known gaps
