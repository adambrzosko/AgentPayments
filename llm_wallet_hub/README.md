# LLM Wallet Hub (Devnet MVP)

Separate software that:
- creates a per-user Solana devnet wallet,
- lets user fund it from any external wallet,
- issues scoped API keys for LLM tool calls,
- enforces hard policy controls,
- exposes a payment tool endpoint and generated system prompt.

## What this is
MVP for cross-LLM wallet execution via tools (GPT/Claude/Gemini).

LLM does **not** hold keys. It calls a tool endpoint with a user API key.
Server enforces policy and signs transactions.

## Run
```bash
cd llm_wallet_hub
npm install
cp .env.example .env
# set MASTER_KEY
npm run dev
# open http://localhost:8787
```

## Core endpoints
- `POST /api/signup` -> create account + wallet
- `POST /api/login`
- `GET /api/me` -> wallet + balance
- `POST /api/keys` -> issue tool key
- `GET /api/system-prompt?model=gpt|claude|gemini`
- `POST /api/tool/pay` (header `x-wallet-tool-key`)
- `GET /api/tool/balance` (header `x-wallet-tool-key`)

## Security model (MVP)
- Passwords: `scrypt`
- Wallet secret key: encrypted (AES-256-GCM) under `MASTER_KEY`
- Tool key required for payment endpoints
- Hard policy checks:
  - max per payment
  - daily cap
  - optional recipient allowlist

## Known gaps before production
- No MFA / no email verification
- JSON file storage (replace with Postgres)
- No key rotation UX, no signed challenge validation yet
- No per-domain policy / no challenge-price verification
- No idempotency keys / no approval workflow above thresholds

## Example tool call
```bash
curl -X POST http://localhost:8787/api/tool/pay \
  -H 'Content-Type: application/json' \
  -H 'x-wallet-tool-key: ak_...' \
  -d '{
    "recipient": "RecipientPublicKey",
    "amountSol": 0.01,
    "reason": "Need access to paywalled docs",
    "resourceUrl": "https://example.com/docs"
  }'
```
