# CLAUDE.md

Claude-specific instructions for this repo. See [AGENTS.md](AGENTS.md) for general agent rules.

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
  - `sdk/constants.json`: Centralized Solana addresses, limits, config — single source of truth.
  - `sdk/node/`: `@agentpayments/node` (Express-first, CommonJS, TypeScript types).
  - `sdk/edge/`: `@agentpayments/edge` (Cloudflare/Netlify/Vercel adapters, ESM, TypeScript types).
  - `sdk/python/`: `agentpayments-python` (Django/FastAPI/Flask adapters).
  - `sdk/next/`: `@agentpayments/next` (Next.js middleware wrapper).
  - Planned: proxy adapter.
- `python_implementation/django/`: Django integration demo.
- `edge_implementation/netlify/`: Netlify deployment files.
- `edge_implementation/cloudflare_worker/`: Cloudflare Worker integration demo.
- `node_implementation/`: Node/Express integration demo.
- `next_implementation/`: Next.js integration demo.
- `scripts/`: Demo and verification scripts.

## Key Patterns

- All constants centralized in `sdk/constants.json` — JS imports via `require`/`import`, Python reads via `pathlib`.
- Edge SDK uses `crypto.subtle` (Web Crypto API) + custom `timingSafeEqual()`, Node SDK uses `node:crypto`.
- Python uses `hmac.compare_digest()` for all timing-safe comparisons.
- All SDKs have payment verification caching (10-min TTL, 1000 entries max).
- All SDKs have rate limiting on challenge verify endpoint (20 req/min/IP).
- Django reads config from `settings.*`, FastAPI/Flask from constructor args.
- Edge SDK runs per-request (env resolved each call), Node SDK resolves at init.

## Expectations

- Keep diffs focused and avoid unrelated refactors.
- Follow existing code style and structure.
- Avoid destructive git/file operations unless explicitly requested.
- Do not add secrets, keys, or sensitive values to tracked files.
- When changing gate behavior, check cross-runtime parity (Node, Edge, Python).

## Verification

| Change area | Command |
|---|---|
| Node SDK | `node -e "require('./sdk/node/index.js')"` |
| Edge/Cloudflare | `npx wrangler deploy` from `edge_implementation/cloudflare_worker/` |
| Python syntax | `python3 -c "import ast; ast.parse(open(f).read())"` for each changed file |
| Django | `python python_implementation/django/manage.py check` (requires venv) |

Report any command you could not run and why.

## Handoff Format

Summarize:
- Files changed
- Behavior impact
- Validation performed
- Known gaps
