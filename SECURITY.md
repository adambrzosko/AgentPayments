# Security

This document describes the security model of AgentPayments, the threats it addresses, and the defenses built into the SDK.

## Threat Model

AgentPayments sits at the edge of a web application and decides whether to allow or block each request. The primary threats are:

| Threat | Impact | Mitigation |
|---|---|---|
| **Timing attacks on HMAC** | Attacker infers valid signatures byte-by-byte | Timing-safe comparison in all SDKs |
| **Agent key forgery** | Attacker crafts a key that passes validation without paying | HMAC-SHA256 signing; keys are `ag_<random>_<hmac>` |
| **Cookie forgery** | Attacker crafts a verification cookie to bypass the challenge | HMAC-signed timestamp cookies with expiry |
| **Nonce replay** | Attacker reuses a captured challenge nonce | 5-minute nonce expiry + HMAC signature |
| **Challenge endpoint abuse** | Attacker brute-forces verification to extract cookies | Rate limiting (20 req/min/IP) |
| **Oversized input injection** | Attacker sends huge payloads to cause memory issues | Input size limits on all user-supplied fields |
| **Invalid wallet address** | Misconfigured wallet causes silent payment failures | Base58 validation at init time |
| **Insecure default secret** | Deployed with `default-secret-change-me` | Warns in debug, throws/500s in production |
| **Redundant RPC calls** | Repeated on-chain lookups for the same agent key | Payment verification cache (10-min TTL) |
| **Bot detection bypass** | Headless browsers pass the challenge | Canvas fingerprint + `navigator.webdriver` check |

## Cryptographic Primitives

### HMAC-SHA256

All signatures (agent keys, cookies, nonces) use HMAC-SHA256 with the `CHALLENGE_SECRET` as the key.

- **Node SDK**: `crypto.createHmac('sha256', secret)` from `node:crypto`
- **Edge SDK**: `crypto.subtle.sign('HMAC', key, data)` via Web Crypto API
- **Python SDK**: `hmac.new(secret, data, hashlib.sha256)` from stdlib

### Timing-Safe Comparison

Every HMAC check uses constant-time comparison to prevent timing side-channels:

- **Node**: `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))`
- **Edge**: Custom HMAC-then-XOR — both values are HMAC'd with a fixed key, then XOR'd byte-by-byte. This avoids the lack of `timingSafeEqual` in Web Crypto.
- **Python**: `hmac.compare_digest(a, b)`

### Agent Key Format

```
ag_<16-char-random>_<16-char-hmac>
```

- `ag_` prefix identifies the key type.
- The random portion is a UUID fragment.
- The HMAC is `hmacSign(random, CHALLENGE_SECRET)` truncated to 16 hex chars.
- Max key length: 64 characters.

### Cookie Format

```
<timestamp>.<hmac>
```

- Timestamp is `Date.now()` at cookie creation.
- HMAC is `hmacSign(timestamp, CHALLENGE_SECRET)`.
- Cookie name: `__agp_verified`.
- Max age: 86400 seconds (24 hours).
- Flags: `HttpOnly`, `Secure`, `SameSite=Lax`.

### Nonce Format

```
<timestamp>.<hmac>
```

- Timestamp is `Date.now()` at nonce creation.
- HMAC is `hmacSign("nonce:<timestamp>", CHALLENGE_SECRET)`.
- Expires after 5 minutes (300,000 ms).

## Input Validation

All user-supplied inputs are truncated before processing:

| Field | Max Length | Source |
|---|---|---|
| Agent key (`X-Agent-Key`) | 64 chars | `sdk/constants.json` |
| Nonce | 128 chars | `sdk/constants.json` |
| Return URL (`return_to`) | 2048 chars | `sdk/constants.json` |
| Canvas fingerprint (`fp`) | 128 chars | `sdk/constants.json` |

Wallet addresses are validated against the base58 regex `/^[1-9A-HJ-NP-Za-km-z]{32,44}$/` at initialization time.

## Rate Limiting

The `/__challenge/verify` endpoint is rate-limited to **20 requests per minute per IP**.

- Node/Edge: in-memory `Map` with sliding window cleanup.
- Python: thread-safe `RateLimiter` class with `threading.Lock`.

Exceeding the limit returns `429 Too Many Requests`.

## Payment Verification Cache

Successful on-chain payment verifications are cached to avoid repeated Solana RPC calls:

- **TTL**: 10 minutes
- **Max entries**: 1,000 (oldest evicted first)
- **Key**: agent key string
- Cache miss triggers a fresh RPC verification; cache hit returns immediately.

## Default Secret Detection

If `CHALLENGE_SECRET` is set to `'default-secret-change-me'`:

| Mode | Behavior |
|---|---|
| Debug (`DEBUG=true`) | Logs a warning, continues running |
| Production (`DEBUG=false`) | Node SDK throws, Edge SDK returns 500, Python raises `RuntimeError` |

## Browser Challenge

The challenge page served to browser visitors:

1. Checks `navigator.webdriver` (rejects headless browsers).
2. Renders a canvas fingerprint to detect non-browser environments.
3. Validates `window.innerWidth` is non-zero (screens have dimensions).
4. Submits nonce + fingerprint + return URL via hidden form POST.
5. Includes `<noscript>` fallback for JavaScript-disabled users.
6. Uses `role="status"` and `aria-live="polite"` for accessibility.

## Responsible Disclosure

If you discover a security vulnerability, please report it privately. Do not open a public GitHub issue.

Contact the maintainers directly with details of the vulnerability, steps to reproduce, and any suggested fixes.
