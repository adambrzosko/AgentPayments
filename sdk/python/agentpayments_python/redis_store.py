"""
RedisStore -- pluggable state backend for the Python SDK using Redis.

Designed for multi-process Django/FastAPI/Flask deployments (e.g.
`gunicorn -w 4`) where the built-in in-memory rate limiters and payment
cache are per-process and therefore far less effective than intended: a
paid key's positive/negative cache result, and each IP's rate-limit
count, only apply within the one worker process that happened to handle
that request.

Usage:

    import redis
    from agentpayments_python.redis_store import create_redis_store

    r = redis.Redis.from_url(os.environ["REDIS_URL"])
    store = create_redis_store(r)

    # FastAPI / Flask constructor kwargs
    register_agentpayments(app, ...,
        agent_key_rate_limiter=store["agent_key_rate_limiter"],
        challenge_verify_rate_limiter=store["challenge_verify_rate_limiter"],
        challenge_issue_rate_limiter=store["challenge_issue_rate_limiter"],
        payment_cache=store["payment_cache"],
    )

    # Django settings.py
    AGENTPAYMENTS_AGENT_KEY_RATE_LIMITER = store["agent_key_rate_limiter"]
    AGENTPAYMENTS_CHALLENGE_VERIFY_RATE_LIMITER = store["challenge_verify_rate_limiter"]
    AGENTPAYMENTS_CHALLENGE_ISSUE_RATE_LIMITER = store["challenge_issue_rate_limiter"]
    AGENTPAYMENTS_PAYMENT_CACHE = store["payment_cache"]

Duck-typed against any client exposing `eval(script, numkeys, *keys_and_args)`,
`get(key)`, and `set(key, value, ex=ttl_seconds)` -- redis-py's `Redis`
client satisfies this directly. This module has no hard dependency on the
`redis` package itself (mirrors sdk/node/redis-store.js) -- bring your own
client.

Atomicity: RateLimiter uses a Lua INCR+EXPIRE script executed atomically
server-side, so there is no read-modify-write race under concurrent
requests. PaymentCache uses plain SET EX.

Fails open on Redis errors -- a Redis outage must not block legitimate
traffic (rate limiter allows the request through) or brick payment
verification (a cache error just falls through to a normal chain scan).
"""

from __future__ import annotations

import logging

logger = logging.getLogger("agentpayments")

RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_MAX = 20
AGENT_KEY_RATE_LIMIT_MAX = 10
CHALLENGE_ISSUE_RATE_LIMIT_MAX = 30

# Atomically increment and set a TTL only on the first hit in the window.
# Returns the current count after increment.
_INCR_SCRIPT = """
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
"""


class RateLimiter:
    """Drop-in replacement for agentpayments_python.ratelimit.RateLimiter."""

    def __init__(self, redis_client, window: int = RATE_LIMIT_WINDOW, max_hits: int = RATE_LIMIT_MAX, key_prefix: str = "agp:rl:"):
        self._redis = redis_client
        self._window = window
        self._max = max_hits
        self._prefix = key_prefix

    def check(self, key: str) -> bool:
        """Returns True if the request should be allowed, False if rate-limited."""
        try:
            count = self._redis.eval(_INCR_SCRIPT, 1, f"{self._prefix}{key}", self._window)
            return int(count) <= self._max
        except Exception as exc:
            logger.error("[agentpayments] RedisStore.RateLimiter error: %s", exc)
            return True  # fail open — don't block legitimate traffic


class PaymentCache:
    """Drop-in replacement for the module-level _payment_cache in solana.py."""

    def __init__(self, redis_client, key_prefix: str = "agp:pay:"):
        self._redis = redis_client
        self._prefix = key_prefix

    def get(self, agent_key: str):
        """Returns True, False, or None (not cached / expired / error)."""
        try:
            val = self._redis.get(f"{self._prefix}{agent_key}")
            if val is None:
                return None
            if isinstance(val, bytes):
                val = val.decode()
            return val == "1"
        except Exception as exc:
            logger.error("[agentpayments] RedisStore.PaymentCache.get error: %s", exc)
            return None

    def set(self, agent_key: str, value: bool, ttl: int) -> None:
        """ttl is in seconds, matching solana.py's _PaymentCache.set signature."""
        try:
            self._redis.set(f"{self._prefix}{agent_key}", "1" if value else "0", ex=max(1, int(ttl)))
        except Exception as exc:
            logger.error("[agentpayments] RedisStore.PaymentCache.set error: %s", exc)


def create_redis_store(redis_client) -> dict:
    """
    Convenience factory: create pre-configured rate limiters matching the
    built-in defaults (challenge verify 20/min, agent-key 10/min, challenge
    issuance 30/min), plus a shared payment cache.
    """
    return {
        "challenge_verify_rate_limiter": RateLimiter(redis_client, max_hits=RATE_LIMIT_MAX, key_prefix="agp:rl:cv:"),
        "agent_key_rate_limiter": RateLimiter(redis_client, max_hits=AGENT_KEY_RATE_LIMIT_MAX, key_prefix="agp:rl:ak:"),
        "challenge_issue_rate_limiter": RateLimiter(redis_client, max_hits=CHALLENGE_ISSUE_RATE_LIMIT_MAX, key_prefix="agp:rl:ci:"),
        "payment_cache": PaymentCache(redis_client),
    }
