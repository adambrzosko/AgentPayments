# agentpayments-python

Python adapters for the AgentPayments gate. Supports Django, FastAPI/Starlette, and Flask.

## Install

```bash
pip install agentpayments-python
# or, in this monorepo:
# pip install -e sdk/python
```

## Django

```python
# settings.py
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "agentpayments_python.django_adapter.GateMiddleware",
    # ... other middleware
]

# Required settings
CHALLENGE_SECRET = os.environ["CHALLENGE_SECRET"]
HOME_WALLET_ADDRESS = os.environ["HOME_WALLET_ADDRESS"]

# Optional settings
SOLANA_RPC_URL = os.environ.get("SOLANA_RPC_URL")
USDC_MINT = os.environ.get("USDC_MINT")
DEBUG = True  # True = devnet, False = mainnet
```

## FastAPI

```python
from fastapi import FastAPI, Request
from agentpayments_python.fastapi_adapter import (
    AgentPaymentsASGIMiddleware,
    challenge_verify_endpoint,
)

app = FastAPI()

app.add_middleware(
    AgentPaymentsASGIMiddleware,
    challenge_secret=os.environ["CHALLENGE_SECRET"],
    home_wallet_address=os.environ["HOME_WALLET_ADDRESS"],
    debug=True,
)

@app.post("/__challenge/verify")
async def verify(request: Request):
    return await challenge_verify_endpoint(
        request,
        challenge_secret=os.environ["CHALLENGE_SECRET"],
    )
```

## Flask

```python
from flask import Flask
from agentpayments_python.flask_adapter import register_agentpayments

app = Flask(__name__)
register_agentpayments(
    app,
    challenge_secret=os.environ["CHALLENGE_SECRET"],
    home_wallet_address=os.environ["HOME_WALLET_ADDRESS"],
    debug=True,
)
```

## Configuration

| Parameter | Required | Default | Description |
|---|---|---|---|
| `challenge_secret` | Yes (production) | `'default-secret-change-me'` | HMAC secret for signing cookies, nonces, and agent keys. |
| `home_wallet_address` | Yes | `''` | Solana wallet address to receive USDC payments. |
| `solana_rpc_url` | No | Auto (devnet/mainnet) | Custom Solana RPC endpoint. |
| `usdc_mint` | No | Auto (devnet/mainnet) | Custom USDC mint address. |
| `min_payment` | No | `0.01` | Minimum USDC payment required. Ignored when `pricing_tiers` is set (the lowest tier's `min_amount` becomes the floor). |
| `access_duration` | No | `None` (forever) | Seconds a successful payment grants access for. Requires `grant_store` to actually persist. |
| `pricing_tiers` | No | `None` | Payment-amount → access mapping: `[{"min_amount": ..., "duration_seconds": ..., "name": ...}]`. Overrides `min_payment`/`access_duration`. |
| `routes` | No | `None` | Per-route overrides for a single middleware instance: `[{"path_prefix": ..., "min_payment": ..., "access_duration": ..., "pricing_tiers": ...}]`, matched by longest `path_prefix`. |
| `debug` | No | `True` | `True` = devnet. `False` = mainnet + strict mode. |
| `api_key` | No | `None` | AgentPayments hosted-platform API key (`ap_live_...`). When set, agent keys are issued and metered via the platform instead of self-signed locally. See **Hosted Platform Mode** below. |
| `platform_url` | No | AgentPayments-hosted URL | Override for a self-hosted platform API. |

Django reads these from `settings.*` (e.g., `settings.CHALLENGE_SECRET`, `settings.AGENTPAYMENTS_API_KEY`). FastAPI and Flask accept them as constructor arguments.

## Hosted Platform Mode

Setting `api_key` switches agent-key issuance from local (`ag_...`) to platform-issued (`agp_...`), and — when the platform account has an on-chain fee configured — every 402 response's `payment` dict gains a `platform_fee` field describing a second required USDC transfer, to be sent in the **same Solana transaction** as the vendor payment. Missing that second transfer is treated as an unpaid request, same as any other invalid payment. This is opt-in per vendor account and has no effect on self-hosted deployments (no `api_key`). The standards-compliant `accepts[]`/`X-PAYMENT-REQUIRED` x402 fields are untouched — they still describe only the vendor leg.

## Pricing & Access Model

By default one `min_payment` buys indefinite access. Three parameters layer on top, identical across Django/FastAPI/Flask (Django via `settings.AGENTPAYMENTS_*`, the others as constructor kwargs):

```python
# FastAPI / Flask
register_agentpayments(  # or AgentPaymentsASGIMiddleware(...)
    app, ...,
    grant_store=FileGrantStore("./data/grants.json"),  # required for duration/tiers to persist
    access_duration=86400,  # seconds; a paid key is only good for 24h, then re-verifies
    pricing_tiers=[
        {"min_amount": 0.01, "duration_seconds": 3600,  "name": "hourly"},
        {"min_amount": 0.05, "duration_seconds": 86400, "name": "daily"},
        {"min_amount": 0.50, "duration_seconds": None,  "name": "lifetime"},
    ],
    routes=[
        {"path_prefix": "/api/premium", "min_payment": 0.05},
        {"path_prefix": "/api/basic",   "min_payment": 0.01},
    ],
)
```

```python
# Django settings.py
AGENTPAYMENTS_GRANT_STORE = FileGrantStore("/var/data/agp_grants.json")
AGENTPAYMENTS_ACCESS_DURATION = 86400
AGENTPAYMENTS_PRICING_TIERS = [...]  # same shape as above
AGENTPAYMENTS_ROUTES = [...]
```

`pricing_tiers` overrides `min_payment`/`access_duration` when set — the gate finds the highest tier the actual on-chain payment clears and grants that tier's duration; the lowest tier's `min_amount` becomes the floor price for any access at all. Every non-floor tier also appears as its own entry in the 402 response's x402 `accepts[]` array. `routes` is matched by longest `path_prefix` on a path-segment boundary; unmatched requests fall back to the top-level `min_payment`/`access_duration`/`pricing_tiers`.

**Revocation**: `MemoryGrantStore`/`FileGrantStore` (`agentpayments_python.grant_store`) both gained a `revoke(agent_key)` method — call it from your own admin view to cut off a specific paid key early. The adapters need no changes to respect this: `has()` already returns `False` for a revoked (or expired) grant. A grants file written by an older SDK version (a plain JSON array of key strings) is still read correctly as a set of permanent grants.

## Security Features

- **Timing-safe HMAC comparison** — uses `hmac.compare_digest()` for all signature checks
- **Payment verification cache** — 10-minute TTL, 1000-entry max (thread-safe)
- **Rate limiting** — 20 challenge verifications per minute per IP (thread-safe)
- **Input size limits** — key (64 chars), nonce (128), return URL (2048), fingerprint (128)
- **Wallet address validation** — base58 format, 32-44 chars, validated at init
- **Default secret detection** — warns in debug, raises `RuntimeError` in production
- **Secure cookies** — Django auto-detects HTTPS via `request.is_secure()`

## Module Structure

```
agentpayments_python/
  __init__.py
  django_adapter.py      Django middleware (GateMiddleware)
  fastapi_adapter.py     FastAPI/Starlette ASGI middleware
  flask_adapter.py       Flask integration (before_request hook)
  challenge.py           Shared challenge HTML generation
  cookies.py             Cookie creation and validation
  crypto.py              HMAC signing and agent key management
  detection.py           Browser detection and public path checks
  solana.py              On-chain payment verification + caching
  ratelimit.py           Shared IP-based rate limiter
  grant_store.py         Durable paid-key persistence (expiry, revocation)
  pricing.py             Pricing-tier / access-duration / per-route resolution
```

## Notes
- Constants loaded from `sdk/constants.json` via `pathlib`.
- Logging uses Python stdlib `logging` module.
- All shared modules are framework-agnostic; adapters are thin wiring.
