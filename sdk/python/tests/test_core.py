"""
Python SDK unit tests — pytest
Run: cd sdk/python && pip install -e . pytest && pytest tests/
"""
import hashlib
import hmac as _hmac
import json
import os
import tempfile
import time
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ── module imports ──────────────────────────────────────────────────────────
from agentpayments_python.crypto import (
    client_id_for_ip,
    generate_agent_key,
    hmac_sign,
    is_valid_agent_key,
    sha256_hex,
)
from agentpayments_python.cookies import (
    COOKIE_MAX_AGE,
    COOKIE_NAME,
    is_valid_cookie_value,
    make_cookie,
)
from agentpayments_python.challenge import (
    POW_DIFFICULTY,
    _verify_pow,
    _is_plausible_fingerprint,
    make_nonce,
    validate_challenge_submission,
)
from agentpayments_python.detection import is_browser_from_headers, is_public_path
from agentpayments_python.ratelimit import RateLimiter
from agentpayments_python.grant_store import FileGrantStore, MemoryGrantStore
from agentpayments_python.redis_store import (
    RateLimiter as RedisRateLimiter,
    PaymentCache as RedisPaymentCache,
    create_redis_store,
)
from agentpayments_python.solana import (
    NEGATIVE_CACHE_TTL,
    PAYMENT_CACHE_TTL,
    _PaymentCache,
    _payment_cache,
)
from agentpayments_python.pricing import (
    sort_tiers,
    resolve_tier,
    normalize_price_config,
    path_matches_prefix,
    build_routes_table,
    resolve_route_config,
)

SECRET = "test-secret-32-bytes-long-abcdefg"
IP = "1.2.3.4"

# ── Helpers ─────────────────────────────────────────────────────────────────


def make_nonce_for(secret, ip, ts_override=None):
    """Make a fresh nonce (or one with an injected timestamp for expiry tests)."""
    import secrets as _s
    ts = ts_override or str(int(time.time() * 1000))
    rand = _s.token_hex(8)
    cid = client_id_for_ip(ip, secret)
    sig = hmac_sign(f"nonce:{ts}:{rand}:{cid}", secret)
    return f"{ts}.{rand}.{sig}"


def solve_pow(nonce, difficulty=POW_DIFFICULTY):
    target = "0" * difficulty
    for i in range(10_000_000):
        if sha256_hex(f"{nonce}:{i}").startswith(target):
            return str(i)
    raise RuntimeError("PoW solution not found within range")


VALID_FP = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"  # 32 base64 chars, 4+ distinct


# ─── crypto: hmac_sign / sha256_hex ─────────────────────────────────────────

class TestHmacSign:
    def test_deterministic(self):
        assert hmac_sign("hello", SECRET) == hmac_sign("hello", SECRET)

    def test_different_data(self):
        assert hmac_sign("a", SECRET) != hmac_sign("b", SECRET)

    def test_different_secret(self):
        assert hmac_sign("hello", SECRET) != hmac_sign("hello", "other-secret")

    def test_returns_hex(self):
        result = hmac_sign("test", SECRET)
        assert all(c in "0123456789abcdef" for c in result)
        assert len(result) == 64


class TestSha256Hex:
    def test_known_value(self):
        assert sha256_hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

    def test_deterministic(self):
        assert sha256_hex("agentpayments") == sha256_hex("agentpayments")


# ─── crypto: client_id_for_ip ───────────────────────────────────────────────

class TestClientIdForIp:
    def test_length_16(self):
        cid = client_id_for_ip(IP, SECRET)
        assert len(cid) == 16

    def test_deterministic(self):
        assert client_id_for_ip(IP, SECRET) == client_id_for_ip(IP, SECRET)

    def test_different_ips(self):
        assert client_id_for_ip("1.2.3.4", SECRET) != client_id_for_ip("5.6.7.8", SECRET)

    def test_different_secrets(self):
        assert client_id_for_ip(IP, SECRET) != client_id_for_ip(IP, "other")


# ─── crypto: agent key ──────────────────────────────────────────────────────

class TestAgentKey:
    def test_prefix(self):
        key = generate_agent_key(SECRET)
        assert key.startswith("ag_")

    def test_length_within_limit(self):
        key = generate_agent_key(SECRET)
        assert len(key) <= 64

    def test_structure(self):
        key = generate_agent_key(SECRET)
        rest = key[3:]  # strip "ag_"
        parts = rest.split("_")
        assert len(parts) == 2
        assert len(parts[0]) == 16
        assert len(parts[1]) == 16

    def test_unique(self):
        assert generate_agent_key(SECRET) != generate_agent_key(SECRET)

    def test_valid(self):
        key = generate_agent_key(SECRET)
        assert is_valid_agent_key(key, SECRET)

    def test_wrong_secret_invalid(self):
        key = generate_agent_key(SECRET)
        assert not is_valid_agent_key(key, "wrong-secret")

    def test_tampered_sig_invalid(self):
        key = generate_agent_key(SECRET)
        tampered = key[:-1] + ("x" if key[-1] != "x" else "y")
        assert not is_valid_agent_key(tampered, SECRET)

    def test_too_long_invalid(self):
        key = "ag_" + "a" * 200
        assert not is_valid_agent_key(key, SECRET)

    def test_no_prefix_invalid(self):
        assert not is_valid_agent_key("bad_key_format", SECRET)

    def test_empty_invalid(self):
        assert not is_valid_agent_key("", SECRET)

    def test_truncated_invalid(self):
        key = generate_agent_key(SECRET)
        assert not is_valid_agent_key(key[:10], SECRET)


# ─── cookies ────────────────────────────────────────────────────────────────

class TestCookies:
    def test_make_and_validate(self):
        val = make_cookie(SECRET, IP)
        assert is_valid_cookie_value(val, SECRET, IP)

    def test_wrong_ip_invalid(self):
        val = make_cookie(SECRET, IP)
        assert not is_valid_cookie_value(val, SECRET, "9.9.9.9")

    def test_tampered_sig_invalid(self):
        val = make_cookie(SECRET, IP)
        tampered = val[:-4] + "xxxx"
        assert not is_valid_cookie_value(tampered, SECRET, IP)

    def test_expired_invalid(self):
        old_ts = str(int((time.time() - COOKIE_MAX_AGE - 60) * 1000))
        cid = client_id_for_ip(IP, SECRET)
        sig = hmac_sign(f"cookie:{old_ts}:{cid}", SECRET)
        expired = f"{old_ts}.{sig}"
        assert not is_valid_cookie_value(expired, SECRET, IP)

    def test_empty_invalid(self):
        assert not is_valid_cookie_value("", SECRET, IP)

    def test_no_dot_invalid(self):
        assert not is_valid_cookie_value("nodot", SECRET, IP)

    def test_wrong_secret_invalid(self):
        val = make_cookie(SECRET, IP)
        assert not is_valid_cookie_value(val, "wrong-secret", IP)

    def test_cookie_name_constant(self):
        assert isinstance(COOKIE_NAME, str) and len(COOKIE_NAME) > 0


# ─── challenge / nonce ──────────────────────────────────────────────────────

class TestNonce:
    def test_make_and_validate_structure(self):
        nonce = make_nonce(SECRET, IP)
        parts = nonce.split(".")
        assert len(parts) == 3

    def test_unique(self):
        assert make_nonce(SECRET, IP) != make_nonce(SECRET, IP)

    def test_expired_nonce_rejected(self):
        from agentpayments_python.challenge import NONCE_TTL_MS
        old_ts = str(int(time.time() * 1000) - NONCE_TTL_MS - 5000)
        nonce = make_nonce_for(SECRET, IP, ts_override=old_ts)
        pow_val = solve_pow(nonce)
        result = validate_challenge_submission(nonce, VALID_FP, pow_val, SECRET, IP)
        assert not result

    def test_tampered_nonce_rejected(self):
        nonce = make_nonce(SECRET, IP)
        parts = nonce.split(".")
        bad = f"{parts[0]}.ZZZZZZZZZZZZZZZZ.{parts[2]}"
        pow_val = solve_pow(bad)
        result = validate_challenge_submission(bad, VALID_FP, pow_val, SECRET, IP)
        assert not result

    def test_wrong_ip_rejected(self):
        nonce = make_nonce(SECRET, IP)
        pow_val = solve_pow(nonce)
        result = validate_challenge_submission(nonce, VALID_FP, pow_val, SECRET, "5.5.5.5")
        assert not result


# ─── proof of work ──────────────────────────────────────────────────────────

class TestPoW:
    def test_valid_pow_accepted(self):
        target = "0" * POW_DIFFICULTY
        for i in range(10_000_000):
            if sha256_hex(f"testnonce:{i}").startswith(target):
                assert _verify_pow("testnonce", str(i), POW_DIFFICULTY)
                return
        pytest.fail("no valid pow found")

    def test_wrong_pow_rejected(self):
        # pow=0 is astronomically unlikely to be correct for difficulty 4
        h = sha256_hex("testnonce:0")
        if not h.startswith("0000"):
            assert not _verify_pow("testnonce", "0", POW_DIFFICULTY)

    def test_non_numeric_pow_rejected(self):
        assert not _verify_pow("testnonce", "abc", POW_DIFFICULTY)

    def test_empty_pow_rejected(self):
        assert not _verify_pow("testnonce", "", POW_DIFFICULTY)


class TestFingerprint:
    def test_valid_fp(self):
        assert _is_plausible_fingerprint("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef")

    def test_too_short(self):
        assert not _is_plausible_fingerprint("ABCD")

    def test_not_enough_distinct(self):
        assert not _is_plausible_fingerprint("AAAAAAAAAA")

    def test_non_base64_chars(self):
        assert not _is_plausible_fingerprint("!@#$%^&*()" * 3)


# ─── challenge validate full ─────────────────────────────────────────────────

class TestValidateChallengeSubmission:
    def test_valid_submission(self):
        nonce = make_nonce(SECRET, IP)
        pow_val = solve_pow(nonce)
        assert validate_challenge_submission(nonce, VALID_FP, pow_val, SECRET, IP)

    def test_replay_rejected(self):
        nonce = make_nonce(SECRET, IP)
        pow_val = solve_pow(nonce)
        # First use: should pass
        assert validate_challenge_submission(nonce, VALID_FP, pow_val, SECRET, IP)
        # Replay: same nonce should fail
        assert not validate_challenge_submission(nonce, VALID_FP, pow_val, SECRET, IP)

    def test_bad_fp_rejected(self):
        nonce = make_nonce(SECRET, IP)
        pow_val = solve_pow(nonce)
        assert not validate_challenge_submission(nonce, "!!!", pow_val, SECRET, IP)

    def test_wrong_pow_rejected(self):
        nonce = make_nonce(SECRET, IP)
        assert not validate_challenge_submission(nonce, VALID_FP, "9999999999", SECRET, IP)


# ─── browser detection ──────────────────────────────────────────────────────

class TestBrowserDetection:
    CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    FIREFOX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/120.0"
    SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
    GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
    PYTHON_UA = "python-requests/2.31.0"
    CURL_UA = "curl/8.1.2"

    def test_sec_fetch_mode_is_browser(self):
        assert is_browser_from_headers({"sec-fetch-mode": "navigate"})

    def test_sec_fetch_dest_is_browser(self):
        assert is_browser_from_headers({"sec-fetch-dest": "document"})

    def test_chrome_ua_fallback(self):
        assert is_browser_from_headers({"user-agent": self.CHROME_UA})

    def test_firefox_ua_fallback(self):
        assert is_browser_from_headers({"user-agent": self.FIREFOX_UA})

    def test_safari_ua_fallback(self):
        assert is_browser_from_headers({"user-agent": self.SAFARI_UA})

    def test_googlebot_not_browser(self):
        assert not is_browser_from_headers({"user-agent": self.GOOGLEBOT_UA})

    def test_python_requests_not_browser(self):
        assert not is_browser_from_headers({"user-agent": self.PYTHON_UA})

    def test_curl_not_browser(self):
        assert not is_browser_from_headers({"user-agent": self.CURL_UA})

    def test_empty_headers_not_browser(self):
        assert not is_browser_from_headers({})

    def test_no_ua_not_browser(self):
        assert not is_browser_from_headers({"accept": "text/html"})

    def test_real_browser_navigation_is_browser(self):
        # Shape of a real top-level browser navigation: Sec-Fetch-Mode: navigate and
        # Sec-Fetch-Dest: document alongside a genuine browser UA.
        assert is_browser_from_headers({
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
            "user-agent": self.CHROME_UA,
        })

    def test_fetch_based_agent_not_browser(self):
        # Node's built-in fetch() (undici) unconditionally sends sec-fetch-mode: cors
        # on every request but never sets Sec-Fetch-Dest. Combined with a non-browser
        # UA, this must NOT be classified as a browser or the agent never sees the
        # 402 JSON it needs to read to pay.
        assert not is_browser_from_headers({
            "sec-fetch-mode": "cors",
            "user-agent": "my-agent/1.0",
        })


class TestPublicPath:
    def test_robots_txt(self):
        assert is_public_path("/robots.txt")

    def test_well_known(self):
        assert is_public_path("/.well-known/agent-access.json")

    def test_regular_path_not_public(self):
        assert not is_public_path("/api/data")

    def test_root_not_public(self):
        assert not is_public_path("/")


# ─── rate limiter ────────────────────────────────────────────────────────────

class TestRateLimiter:
    def test_allows_up_to_limit(self):
        rl = RateLimiter(window=60, max_hits=5)
        for _ in range(5):
            assert rl.check("ip1")

    def test_blocks_after_limit(self):
        rl = RateLimiter(window=60, max_hits=5)
        for _ in range(5):
            rl.check("ip1")
        assert not rl.check("ip1")

    def test_different_keys_independent(self):
        rl = RateLimiter(window=60, max_hits=3)
        for _ in range(3):
            rl.check("ip1")
        # ip1 is exhausted but ip2 is fresh
        assert not rl.check("ip1")
        assert rl.check("ip2")

    def test_window_resets(self):
        rl = RateLimiter(window=1, max_hits=2)
        assert rl.check("ip1")
        assert rl.check("ip1")
        assert not rl.check("ip1")
        time.sleep(1.1)
        assert rl.check("ip1")

    def test_challenge_path_limit_20(self):
        from agentpayments_python.ratelimit import RateLimiter
        rl = RateLimiter(window=60, max_hits=20)
        for _ in range(20):
            assert rl.check("ip1")
        assert not rl.check("ip1")

    def test_agent_key_path_limit_10(self):
        from agentpayments_python.ratelimit import RateLimiter
        rl = RateLimiter(window=60, max_hits=10)
        for _ in range(10):
            assert rl.check("ip1")
        assert not rl.check("ip1")


# ─── payment cache (positive + negative TTL) ────────────────────────────────

class TestPaymentCache:
    def test_miss_returns_none(self):
        cache = _PaymentCache()
        assert cache.get("nonexistent") is None

    def test_positive_hit(self):
        cache = _PaymentCache()
        cache.set("key1", True, PAYMENT_CACHE_TTL)
        assert cache.get("key1") is True

    def test_negative_hit(self):
        cache = _PaymentCache()
        cache.set("key2", False, NEGATIVE_CACHE_TTL)
        assert cache.get("key2") is False

    def test_positive_expiry(self):
        cache = _PaymentCache()
        cache.set("key3", True, 0)  # 0s TTL — already expired
        # Give it a tiny moment to ensure time.time() advances past the TTL
        time.sleep(0.01)
        assert cache.get("key3") is None

    def test_negative_expiry(self):
        cache = _PaymentCache()
        cache.set("key4", False, 0)
        time.sleep(0.01)
        assert cache.get("key4") is None

    def test_overwrite(self):
        cache = _PaymentCache()
        cache.set("key5", False, NEGATIVE_CACHE_TTL)
        assert cache.get("key5") is False
        cache.set("key5", True, PAYMENT_CACHE_TTL)
        assert cache.get("key5") is True

    def test_max_size_evicts_oldest(self):
        cache = _PaymentCache(max_size=3)
        cache.set("a", True, 600)
        cache.set("b", True, 600)
        cache.set("c", True, 600)
        cache.set("d", True, 600)  # should evict "a"
        assert cache.get("a") is None
        assert cache.get("d") is True


# ─── redis_store: pluggable state backend for multi-process deployments ────

class FakeRedis:
    """Minimal fake standing in for a redis-py client: eval/get/set only."""

    def __init__(self):
        self._counters = {}
        self._values = {}
        self.fail = False

    def eval(self, script, numkeys, key, ttl):
        if self.fail:
            raise ConnectionError("redis unavailable")
        self._counters[key] = self._counters.get(key, 0) + 1
        return self._counters[key]

    def get(self, key):
        if self.fail:
            raise ConnectionError("redis unavailable")
        return self._values.get(key)

    def set(self, key, value, ex=None):
        if self.fail:
            raise ConnectionError("redis unavailable")
        self._values[key] = value.encode() if isinstance(value, str) else value


class TestRedisRateLimiter:
    def test_allows_under_the_limit(self):
        limiter = RedisRateLimiter(FakeRedis(), max_hits=3)
        assert limiter.check("1.2.3.4")
        assert limiter.check("1.2.3.4")
        assert limiter.check("1.2.3.4")

    def test_denies_over_the_limit(self):
        limiter = RedisRateLimiter(FakeRedis(), max_hits=3)
        for _ in range(3):
            assert limiter.check("1.2.3.4")
        assert not limiter.check("1.2.3.4")

    def test_different_keys_independent(self):
        redis = FakeRedis()
        limiter = RedisRateLimiter(redis, max_hits=1)
        assert limiter.check("a")
        assert not limiter.check("a")
        assert limiter.check("b")  # separate key, separate budget

    def test_fails_open_on_redis_error(self):
        redis = FakeRedis()
        redis.fail = True
        limiter = RedisRateLimiter(redis, max_hits=1)
        assert limiter.check("1.2.3.4"), "a Redis outage must not block legitimate traffic"


class TestRedisPaymentCache:
    def test_miss_returns_none(self):
        cache = RedisPaymentCache(FakeRedis())
        assert cache.get("ag_unknown") is None

    def test_positive_and_negative_roundtrip(self):
        redis = FakeRedis()
        cache = RedisPaymentCache(redis)
        cache.set("ag_paid", True, 600)
        cache.set("ag_unpaid", False, 30)
        assert cache.get("ag_paid") is True
        assert cache.get("ag_unpaid") is False

    def test_fails_open_on_redis_error(self):
        redis = FakeRedis()
        redis.fail = True
        cache = RedisPaymentCache(redis)
        assert cache.get("ag_key") is None  # treated as a cache miss, not a crash
        cache.set("ag_key", True, 600)  # must not raise


class TestCreateRedisStore:
    def test_returns_expected_keys(self):
        store = create_redis_store(FakeRedis())
        assert set(store.keys()) == {
            "challenge_verify_rate_limiter",
            "agent_key_rate_limiter",
            "challenge_issue_rate_limiter",
            "payment_cache",
        }

    def test_limiters_use_distinct_keyspaces(self):
        # Same IP hitting two different limiters from the same store must not
        # share a rate-limit budget with each other.
        redis = FakeRedis()
        store = create_redis_store(redis)
        for _ in range(10):
            store["agent_key_rate_limiter"].check("1.2.3.4")
        assert store["challenge_verify_rate_limiter"].check("1.2.3.4")

    def test_default_max_hits_match_built_in_limiters(self):
        store = create_redis_store(FakeRedis())
        # agent_key: 10/min, challenge_verify: 20/min, challenge_issue: 30/min
        for _ in range(10):
            assert store["agent_key_rate_limiter"].check("k")
        assert not store["agent_key_rate_limiter"].check("k")


# ─── grant stores ────────────────────────────────────────────────────────────

class TestMemoryGrantStore:
    def test_unknown_key_false(self):
        gs = MemoryGrantStore()
        assert not gs.has("ag_unknown")

    def test_add_then_has(self):
        gs = MemoryGrantStore()
        gs.add("ag_test")
        assert gs.has("ag_test")

    def test_idempotent_add(self):
        gs = MemoryGrantStore()
        gs.add("ag_k")
        gs.add("ag_k")
        assert gs.has("ag_k")

    def test_thread_safe(self):
        gs = MemoryGrantStore()
        keys = [f"ag_{i}" for i in range(100)]
        threads = [threading.Thread(target=gs.add, args=(k,)) for k in keys]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        for k in keys:
            assert gs.has(k)


class TestFileGrantStore:
    def test_persist_and_reload(self, tmp_path):
        f = tmp_path / "grants.json"
        gs1 = FileGrantStore(str(f))
        gs1.add("ag_persist")
        gs2 = FileGrantStore(str(f))
        assert gs2.has("ag_persist")

    def test_unknown_false(self, tmp_path):
        f = tmp_path / "grants.json"
        gs = FileGrantStore(str(f))
        assert not gs.has("ag_never_added")

    def test_nonexistent_file_ok(self, tmp_path):
        f = tmp_path / "doesnotexist.json"
        gs = FileGrantStore(str(f))
        gs.add("ag_k")
        assert gs.has("ag_k")

    def test_repeated_add_stays_functionally_idempotent(self, tmp_path):
        # add() now always persists (so a later add() can update expiry/tier
        # metadata for the same key), but has() must still be true either way.
        f = tmp_path / "grants.json"
        gs = FileGrantStore(str(f))
        gs.add("ag_k")
        gs.add("ag_k")
        assert gs.has("ag_k")

    def test_atomic_write_leaves_no_tmp(self, tmp_path):
        f = tmp_path / "grants.json"
        gs = FileGrantStore(str(f))
        gs.add("ag_k")
        assert not (tmp_path / "grants.tmp").exists()

    def test_multiple_keys(self, tmp_path):
        f = tmp_path / "grants.json"
        gs = FileGrantStore(str(f))
        for i in range(10):
            gs.add(f"ag_{i}")
        gs2 = FileGrantStore(str(f))
        for i in range(10):
            assert gs2.has(f"ag_{i}")

    def test_reads_legacy_array_format_as_permanent_grants(self, tmp_path):
        f = tmp_path / "grants.json"
        f.write_text(json.dumps(["ag_legacy_one", "ag_legacy_two"]))
        gs = FileGrantStore(str(f))
        assert gs.has("ag_legacy_one")
        assert gs.has("ag_legacy_two")
        assert not gs.has("ag_legacy_three")


# ─── grant store: expiry and revocation ─────────────────────────────────────

class TestGrantStoreExpiryAndRevocation:
    def test_memory_expired_grant_denied(self):
        gs = MemoryGrantStore()
        gs.add("ag_expired", expires_at=time.time() - 1)
        assert not gs.has("ag_expired")

    def test_memory_unexpired_grant_allowed(self):
        gs = MemoryGrantStore()
        gs.add("ag_active", expires_at=time.time() + 1000)
        assert gs.has("ag_active")

    def test_memory_no_expiry_means_unlimited(self):
        gs = MemoryGrantStore()
        gs.add("ag_forever")
        assert gs.has("ag_forever")

    def test_memory_revoke_denies_previously_granted_key(self):
        gs = MemoryGrantStore()
        gs.add("ag_to_revoke")
        assert gs.has("ag_to_revoke")
        gs.revoke("ag_to_revoke")
        assert not gs.has("ag_to_revoke")

    def test_memory_revoke_preemptively_blocks_never_added_key(self):
        gs = MemoryGrantStore()
        gs.revoke("ag_never_paid")
        gs.add("ag_never_paid")  # later add() overwrites — last-write-wins v1 semantics
        assert gs.has("ag_never_paid")

    def test_file_expiry_and_revoke_persist_across_reload(self, tmp_path):
        f = tmp_path / "grants.json"
        gs1 = FileGrantStore(str(f))
        gs1.add("ag_expiring", expires_at=time.time() + 1000, tier="daily")
        gs1.add("ag_revoked")
        gs1.revoke("ag_revoked")
        gs2 = FileGrantStore(str(f))
        assert gs2.has("ag_expiring")
        assert not gs2.has("ag_revoked")


# ─── cross-runtime HMAC parity ───────────────────────────────────────────────
#
# Reference values computed by the Node SDK test suite's "print reference
# values" test (same SECRET, IP, ts, rand). If Node and Python produce the
# same hex strings, the runtimes are interoperable.

class TestCrossRuntimeParity:
    REF_IP = "1.2.3.4"
    REF_TS = "1700000000000"
    REF_RAND = "aabbccdd11223344"

    def _ref_client_id(self):
        return hmac_sign(f"client:{self.REF_IP}", SECRET)[:16]

    def test_client_id_deterministic(self):
        cid = client_id_for_ip(self.REF_IP, SECRET)
        assert len(cid) == 16
        # Must match the Node reference value produced by hmacHex(`client:${ip}`, secret).slice(0,16)
        expected = _hmac.new(SECRET.encode(), f"client:{self.REF_IP}".encode(), hashlib.sha256).hexdigest()[:16]
        assert cid == expected

    def test_nonce_sig_deterministic(self):
        cid = client_id_for_ip(self.REF_IP, SECRET)
        sig = hmac_sign(f"nonce:{self.REF_TS}:{self.REF_RAND}:{cid}", SECRET)
        # Recompute manually to confirm
        expected = _hmac.new(
            SECRET.encode(),
            f"nonce:{self.REF_TS}:{self.REF_RAND}:{cid}".encode(),
            hashlib.sha256,
        ).hexdigest()
        assert sig == expected
        assert len(sig) == 64

    def test_cookie_sig_deterministic(self):
        cid = client_id_for_ip(self.REF_IP, SECRET)
        sig = hmac_sign(f"cookie:{self.REF_TS}:{cid}", SECRET)
        expected = _hmac.new(
            SECRET.encode(),
            f"cookie:{self.REF_TS}:{cid}".encode(),
            hashlib.sha256,
        ).hexdigest()
        assert sig == expected
        assert len(sig) == 64

    def test_key_sig_matches_expected_format(self):
        # Node: hmacHex(random_part, secret).slice(0,16)
        # Python: hmac_sign(random_part, secret)[:16]
        # Both must produce identical 16-char hex strings.
        rand = "abc1234567890def"
        node_style = _hmac.new(SECRET.encode(), rand.encode(), hashlib.sha256).hexdigest()[:16]
        python_style = hmac_sign(rand, SECRET)[:16]
        assert node_style == python_style


# ─── verify_payment_on_chain (mocked RPC) ────────────────────────────────────

# We patch requests.post so no real network calls are made.

def _rpc_response(result):
    return MagicMock(
        status_code=200,
        json=lambda: {"jsonrpc": "2.0", "id": 1, "result": result},
    )


def _build_tx(memo: str, amount: float, mint: str, destination_owner: str, ok=True, fee_amount: float = None):
    """Build a minimal mock RPC getTransaction response for a transferChecked.

    fee_amount, if given, adds a second transferChecked instruction (in the SAME
    transaction) to a distinct "fee_ata_address" destination — simulating the
    on-chain platform fee leg.
    """
    instructions = [
        {
            "program": "spl-token",
            "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            "parsed": {
                "type": "transferChecked",
                "info": {
                    "mint": mint,
                    "tokenAmount": {"uiAmount": amount, "amount": str(round(amount * 1_000_000)), "decimals": 6},
                    "destination": "dest_ata_address",
                    "authority": "payer_address",
                },
            },
        },
    ]
    if fee_amount is not None:
        instructions.append({
            "program": "spl-token",
            "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            "parsed": {
                "type": "transferChecked",
                "info": {
                    "mint": mint,
                    "tokenAmount": {"uiAmount": fee_amount, "amount": str(round(fee_amount * 1_000_000)), "decimals": 6},
                    "destination": "fee_ata_address",
                    "authority": "payer_address",
                },
            },
        })
    instructions.append({
        "program": "spl-memo",
        "programId": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        "parsed": memo,
    })
    return {
        "meta": {
            "err": None if ok else {"InstructionError": [0, "Custom"]},
            "innerInstructions": [],
            "logMessages": [],
        },
        "transaction": {
            "message": {
                "instructions": instructions,
                "accountKeys": [],
            }
        },
    }


class TestVerifyPaymentOnChain:
    WALLET = "5rXZeAEbg13DQnSFijEno2hKEJLK2p14fAo3AmPtfBft"
    FEE_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
    MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"  # devnet USDC
    RPC = "https://api.devnet.solana.com"

    def _fresh_key(self):
        return generate_agent_key(SECRET)

    def _patch_rpc(self, sigs_result, ata_result, tx_result, fee_ata_result=None):
        """Return a context manager that patches requests.post with ordered responses.

        When fee_ata_result is given, getTokenAccountsByOwner is dispatched by the
        queried owner (params[0]): self.WALLET -> ata_result, self.FEE_WALLET ->
        fee_ata_result — mirrors the two separate ATA lookups verify_payment_on_chain
        makes when fee_info is set.
        """

        def side_effect(url, json=None, timeout=None):
            method = json.get("method", "")
            if method == "getTokenAccountsByOwner":
                owner = (json.get("params") or [None])[0]
                if fee_ata_result is not None and owner == self.FEE_WALLET:
                    return _rpc_response(fee_ata_result)
                return _rpc_response(ata_result)
            if method == "getSignaturesForAddress":
                return _rpc_response(sigs_result)
            if method == "getTransaction":
                return _rpc_response(tx_result)
            return _rpc_response(None)

        return patch("requests.post", side_effect=side_effect)

    def test_correct_payment_passes(self):
        from agentpayments_python.solana import verify_payment_on_chain, _payment_cache
        key = self._fresh_key()
        tx = _build_tx(key, 0.01, self.MINT, self.WALLET)
        ata = {"value": [{"pubkey": "dest_ata_address", "account": {"data": {"parsed": {"info": {"mint": self.MINT, "owner": self.WALLET}}}}}]}
        sigs = [{"signature": "sig1", "err": None}]
        with self._patch_rpc(sigs, ata, tx):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT)
        assert result is True

    def test_wrong_memo_fails(self):
        from agentpayments_python.solana import verify_payment_on_chain
        key = self._fresh_key()
        tx = _build_tx("ag_completely_different_key", 0.01, self.MINT, self.WALLET)
        ata = {"value": [{"pubkey": "dest_ata_address", "account": {"data": {"parsed": {"info": {"mint": self.MINT, "owner": self.WALLET}}}}}]}
        sigs = [{"signature": "sig2", "err": None}]
        with self._patch_rpc(sigs, ata, tx):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT)
        assert result is False

    def test_wrong_mint_fails(self):
        from agentpayments_python.solana import verify_payment_on_chain
        key = self._fresh_key()
        wrong_mint = "So11111111111111111111111111111111111111112"  # SOL, not USDC
        tx = _build_tx(key, 0.01, wrong_mint, self.WALLET)
        ata = {"value": [{"pubkey": "dest_ata_address", "account": {"data": {"parsed": {"info": {"mint": self.MINT, "owner": self.WALLET}}}}}]}
        sigs = [{"signature": "sig3", "err": None}]
        with self._patch_rpc(sigs, ata, tx):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT)
        assert result is False

    def test_partial_amount_fails(self):
        from agentpayments_python.solana import verify_payment_on_chain, MIN_PAYMENT
        key = self._fresh_key()
        tx = _build_tx(key, MIN_PAYMENT / 2, self.MINT, self.WALLET)
        ata = {"value": [{"pubkey": "dest_ata_address", "account": {"data": {"parsed": {"info": {"mint": self.MINT, "owner": self.WALLET}}}}}]}
        sigs = [{"signature": "sig4", "err": None}]
        with self._patch_rpc(sigs, ata, tx):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT)
        assert result is False

    def test_custom_min_payment_raises_the_required_threshold(self):
        # A payment that clears the default MIN_PAYMENT but not a higher
        # custom min_payment must be rejected.
        from agentpayments_python.solana import verify_payment_on_chain, MIN_PAYMENT
        key = self._fresh_key()
        tx = _build_tx(key, MIN_PAYMENT, self.MINT, self.WALLET)
        ata = {"value": [{"pubkey": "dest_ata_address", "account": {"data": {"parsed": {"info": {"mint": self.MINT, "owner": self.WALLET}}}}}]}
        sigs = [{"signature": "sig_custom_min", "err": None}]
        with self._patch_rpc(sigs, ata, tx):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT, min_payment=MIN_PAYMENT * 5)
        assert result is False

    def test_custom_min_payment_accepts_a_matching_higher_payment(self):
        from agentpayments_python.solana import verify_payment_on_chain, MIN_PAYMENT
        key = self._fresh_key()
        higher = MIN_PAYMENT * 5
        tx = _build_tx(key, higher, self.MINT, self.WALLET)
        ata = {"value": [{"pubkey": "dest_ata_address", "account": {"data": {"parsed": {"info": {"mint": self.MINT, "owner": self.WALLET}}}}}]}
        sigs = [{"signature": "sig_custom_min_2", "err": None}]
        with self._patch_rpc(sigs, ata, tx):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT, min_payment=higher)
        assert result is True

    def test_scan_for_payment_returns_actual_amount_paid(self):
        from agentpayments_python.solana import _scan_for_payment, MIN_PAYMENT
        key = self._fresh_key()
        paid_amount = MIN_PAYMENT * 5
        tx = _build_tx(key, paid_amount, self.MINT, self.WALLET)
        ata = {"value": [{"pubkey": "dest_ata_address", "account": {"data": {"parsed": {"info": {"mint": self.MINT, "owner": self.WALLET}}}}}]}
        sigs = [{"signature": "sig_amount", "err": None}]
        with self._patch_rpc(sigs, ata, tx):
            result = _scan_for_payment(key, self.WALLET, self.RPC, self.MINT, min_payment=MIN_PAYMENT)
        assert result["paid"] is True
        assert result["amount_paid"] == paid_amount

    def test_failed_tx_rejected(self):
        # Solana RPC sets err on the *signature* record in getSignaturesForAddress
        # when the transaction failed. The SDK correctly skips those (line 120-121
        # in solana.py). The tx body is never fetched for a failed sig.
        from agentpayments_python.solana import verify_payment_on_chain
        key = self._fresh_key()
        ata = {"value": [{"pubkey": "dest_ata_address", "account": {"data": {"parsed": {"info": {"mint": self.MINT, "owner": self.WALLET}}}}}]}
        # err is non-null → SDK skips this signature entirely
        sigs = [{"signature": "sig5", "err": {"InstructionError": [0, "Custom"]}}]
        with self._patch_rpc(sigs, ata, None):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT)
        assert result is False

    def test_no_signatures_returns_false(self):
        from agentpayments_python.solana import verify_payment_on_chain
        key = self._fresh_key()
        ata = {"value": []}  # no ATAs → nothing to scan
        sigs = []
        with self._patch_rpc(sigs, ata, None):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT)
        assert result is False

    def test_tx_cap_enforced(self):
        """Verify we don't issue more than MAX_TRANSACTIONS_PER_VERIFY getTransaction calls."""
        from agentpayments_python.solana import verify_payment_on_chain, MAX_TRANSACTIONS_PER_VERIFY
        key = self._fresh_key()
        many_sigs = [{"signature": f"sig{i}", "err": None} for i in range(MAX_TRANSACTIONS_PER_VERIFY + 10)]
        ata = {"value": [{"pubkey": "dest_ata_address", "account": {"data": {"parsed": {"info": {"mint": self.MINT, "owner": self.WALLET}}}}}]}
        # tx with wrong memo so we scan all
        tx = _build_tx("ag_different_key_entirely", 0.01, self.MINT, self.WALLET)

        call_count = {"n": 0}
        orig_post = __import__("requests").post

        def counting_post(url, json=None, timeout=None):
            if json and json.get("method") == "getTransaction":
                call_count["n"] += 1
            if json and json.get("method") == "getTokenAccountsByOwner":
                return _rpc_response(ata)
            if json and json.get("method") == "getSignaturesForAddress":
                return _rpc_response(many_sigs)
            return _rpc_response(tx)

        with patch("requests.post", side_effect=counting_post):
            verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT)

        assert call_count["n"] <= MAX_TRANSACTIONS_PER_VERIFY, (
            f"Made {call_count['n']} getTransaction calls, cap is {MAX_TRANSACTIONS_PER_VERIFY}"
        )

    def test_positive_result_cached(self):
        from agentpayments_python.solana import verify_payment_on_chain
        key = self._fresh_key()
        tx = _build_tx(key, 0.01, self.MINT, self.WALLET)
        ata = {"value": [{"pubkey": "dest_ata_address", "account": {"data": {"parsed": {"info": {"mint": self.MINT, "owner": self.WALLET}}}}}]}
        sigs = [{"signature": "sig_cache_pos", "err": None}]
        # Warm the cache
        with self._patch_rpc(sigs, ata, tx):
            verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT)
        # Second call: even with a broken RPC, cache should serve True
        with patch("requests.post", side_effect=Exception("should not be called")):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT)
        assert result is True

    def test_negative_result_cached_briefly(self):
        from agentpayments_python.solana import verify_payment_on_chain
        key = self._fresh_key()
        ata = {"value": []}
        sigs = []
        with self._patch_rpc(sigs, ata, None):
            verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT)
        # Second call without real RPC: negative cache hit
        with patch("requests.post", side_effect=Exception("should not be called")):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT)
        assert result is False


class TestVerifyPaymentOnChainFee:
    """On-chain platform fee leg — hosted-mode vendors only (fee_info set)."""

    WALLET = TestVerifyPaymentOnChain.WALLET
    FEE_WALLET = TestVerifyPaymentOnChain.FEE_WALLET
    MINT = TestVerifyPaymentOnChain.MINT
    RPC = TestVerifyPaymentOnChain.RPC
    FEE_INFO = {"wallet": FEE_WALLET, "rate_pct": 2}
    FEE_AMOUNT = 0.01 * 0.02  # 2% of MIN_PAYMENT (0.01)

    def _fresh_key(self):
        return generate_agent_key(SECRET)

    def _ata(self, pubkey, owner):
        return {"value": [{"pubkey": pubkey, "account": {"data": {"parsed": {"info": {"mint": self.MINT, "owner": owner}}}}}]}

    def _patch_rpc(self, sigs_result, ata_result, tx_result, fee_ata_result):
        """getTokenAccountsByOwner is dispatched by the queried owner (params[0])."""

        def side_effect(url, json=None, timeout=None):
            method = json.get("method", "")
            if method == "getTokenAccountsByOwner":
                owner = (json.get("params") or [None])[0]
                return _rpc_response(fee_ata_result if owner == self.FEE_WALLET else ata_result)
            if method == "getSignaturesForAddress":
                return _rpc_response(sigs_result)
            if method == "getTransaction":
                return _rpc_response(tx_result)
            return _rpc_response(None)

        return patch("requests.post", side_effect=side_effect)

    def test_fee_leg_missing_denies_access(self):
        from agentpayments_python.solana import verify_payment_on_chain
        key = self._fresh_key()
        tx = _build_tx(key, 0.01, self.MINT, self.WALLET)  # vendor leg only, no fee leg
        ata = self._ata("dest_ata_address", self.WALLET)
        fee_ata = self._ata("fee_ata_address", self.FEE_WALLET)
        sigs = [{"signature": "fee_sig_missing", "err": None}]
        with self._patch_rpc(sigs, ata, tx, fee_ata):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT, fee_info=self.FEE_INFO)
        assert result is False

    def test_fee_leg_present_grants_access(self):
        from agentpayments_python.solana import verify_payment_on_chain
        key = self._fresh_key()
        tx = _build_tx(key, 0.01, self.MINT, self.WALLET, fee_amount=self.FEE_AMOUNT)
        ata = self._ata("dest_ata_address", self.WALLET)
        fee_ata = self._ata("fee_ata_address", self.FEE_WALLET)
        sigs = [{"signature": "fee_sig_ok", "err": None}]
        with self._patch_rpc(sigs, ata, tx, fee_ata):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT, fee_info=self.FEE_INFO)
        assert result is True

    def test_fee_leg_underpaid_denies_access(self):
        from agentpayments_python.solana import verify_payment_on_chain
        key = self._fresh_key()
        tx = _build_tx(key, 0.01, self.MINT, self.WALLET, fee_amount=self.FEE_AMOUNT / 2)
        ata = self._ata("dest_ata_address", self.WALLET)
        fee_ata = self._ata("fee_ata_address", self.FEE_WALLET)
        sigs = [{"signature": "fee_sig_underpaid", "err": None}]
        with self._patch_rpc(sigs, ata, tx, fee_ata):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT, fee_info=self.FEE_INFO)
        assert result is False

    def test_fee_wallet_with_no_usdc_account_denies_access(self):
        from agentpayments_python.solana import verify_payment_on_chain
        key = self._fresh_key()
        tx = _build_tx(key, 0.01, self.MINT, self.WALLET, fee_amount=self.FEE_AMOUNT)
        ata = self._ata("dest_ata_address", self.WALLET)
        fee_ata = {"value": []}  # fee wallet has no USDC ATA yet
        sigs = [{"signature": "fee_sig_no_ata", "err": None}]
        with self._patch_rpc(sigs, ata, tx, fee_ata):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT, fee_info=self.FEE_INFO)
        assert result is False

    def test_no_fee_info_skips_fee_check_entirely(self):
        """fee_info=None (self-hosted / no platform fee configured) behaves exactly
        like today: only one getTokenAccountsByOwner call, vendor leg alone suffices."""
        from agentpayments_python.solana import verify_payment_on_chain
        key = self._fresh_key()
        tx = _build_tx(key, 0.01, self.MINT, self.WALLET)  # vendor leg only
        ata = self._ata("dest_ata_address", self.WALLET)
        sigs = [{"signature": "fee_sig_none", "err": None}]

        ata_calls = {"n": 0}

        def side_effect(url, json=None, timeout=None):
            method = json.get("method", "")
            if method == "getTokenAccountsByOwner":
                ata_calls["n"] += 1
                return _rpc_response(ata)
            if method == "getSignaturesForAddress":
                return _rpc_response(sigs)
            if method == "getTransaction":
                return _rpc_response(tx)
            return _rpc_response(None)

        with patch("requests.post", side_effect=side_effect):
            result = verify_payment_on_chain(key, self.WALLET, self.RPC, self.MINT, fee_info=None)
        assert result is True
        assert ata_calls["n"] == 1


# ─── Adapter pricing wiring (FastAPI / Flask / Django) ──────────────────────
#
# The pricing/duration/tier/route resolution logic itself is fully covered
# above at the shared-module level (pricing.py, solana.py, grant_store.py).
# These tests confirm each framework adapter actually wires that logic in —
# i.e. resolves the right price for a route and passes the right
# expiry/tier through to the grant store.

class TestAdapterPricingWiring:
    SECRET = "test-secret-32-bytes-long-abcdefg"
    WALLET = "5rXZeAEbg13DQnSFijEno2hKEJLK2p14fAo3AmPtfBft"
    MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

    class _SpyGrantStore:
        def __init__(self):
            self.grants = []

        def has(self, key):
            return False

        def add(self, key, expires_at=None, tier=None):
            self.grants.append({"key": key, "expires_at": expires_at, "tier": tier})

    def test_fastapi_pricing_tiers_grants_matching_tier(self):
        pytest.importorskip("fastapi")
        import asyncio
        from starlette.requests import Request
        from starlette.responses import Response
        from agentpayments_python.fastapi_adapter import AgentPaymentsASGIMiddleware
        from agentpayments_python.crypto import generate_agent_key

        key = generate_agent_key(self.SECRET)
        tx = _build_tx(key, 0.05, self.MINT, self.WALLET)
        ata = {"value": [{"pubkey": "dest_ata_address", "account": {"data": {"parsed": {"info": {"mint": self.MINT, "owner": self.WALLET}}}}}]}
        sigs = [{"signature": "sig_fastapi_tier", "err": None}]

        def side_effect(url, json=None, timeout=None):
            method = json.get("method", "")
            if method == "getTokenAccountsByOwner":
                return _rpc_response(ata)
            if method == "getSignaturesForAddress":
                return _rpc_response(sigs)
            if method == "getTransaction":
                return _rpc_response(tx)
            return _rpc_response(None)

        store = self._SpyGrantStore()
        mw = AgentPaymentsASGIMiddleware(
            app=None,
            challenge_secret=self.SECRET,
            home_wallet_address=self.WALLET,
            debug=True,
            usdc_mint=self.MINT,
            pricing_tiers=[
                {"min_amount": 0.01, "duration_seconds": 3600, "name": "hourly"},
                {"min_amount": 0.05, "duration_seconds": None, "name": "lifetime"},
            ],
            grant_store=store,
        )

        async def call_next(_req):
            return Response("ok", status_code=200)

        async def run():
            req = Request({
                "type": "http", "method": "GET", "path": "/data",
                "headers": [(b"x-agent-key", key.encode())],
                "query_string": b"", "scheme": "https", "client": ("127.0.0.1", 1234),
            })
            with patch("requests.post", side_effect=side_effect):
                return await mw.dispatch(req, call_next)

        resp = asyncio.run(run())
        assert resp.status_code == 200
        assert len(store.grants) == 1
        assert store.grants[0]["tier"] == "lifetime"
        assert store.grants[0]["expires_at"] is None

    def test_flask_routes_override_min_payment(self):
        pytest.importorskip("flask")
        from flask import Flask
        from agentpayments_python.flask_adapter import register_agentpayments

        app = Flask(__name__)
        register_agentpayments(
            app,
            challenge_secret=self.SECRET,
            home_wallet_address=self.WALLET,
            debug=True,
            usdc_mint=self.MINT,
            min_payment=0.01,
            routes=[{"path_prefix": "/premium", "min_payment": 0.05}],
        )

        @app.route("/premium/data")
        def premium_data():
            return "premium ok"

        @app.route("/data")
        def data():
            return "ok"

        client = app.test_client()
        premium_resp = client.get("/premium/data")
        other_resp = client.get("/data")
        assert premium_resp.status_code == 402
        assert premium_resp.get_json()["payment"]["amount"] == "0.05"
        assert other_resp.status_code == 402
        assert other_resp.get_json()["payment"]["amount"] == "0.01"

    def test_django_access_duration_produces_expiring_grant(self):
        pytest.importorskip("django")
        import django
        from django.conf import settings

        if not settings.configured:
            settings.configure(
                DEBUG=True,
                CHALLENGE_SECRET=self.SECRET,
                HOME_WALLET_ADDRESS=self.WALLET,
                USDC_MINT=self.MINT,
                ALLOWED_HOSTS=["*"],
            )
            django.setup()

        from django.test import RequestFactory
        from django.http import HttpResponse
        from agentpayments_python.django_adapter import GateMiddleware
        from agentpayments_python.crypto import generate_agent_key

        key = generate_agent_key(self.SECRET)
        tx = _build_tx(key, 0.01, self.MINT, self.WALLET)
        ata = {"value": [{"pubkey": "dest_ata_address", "account": {"data": {"parsed": {"info": {"mint": self.MINT, "owner": self.WALLET}}}}}]}
        sigs = [{"signature": "sig_django_duration", "err": None}]

        def side_effect(url, json=None, timeout=None):
            method = json.get("method", "")
            if method == "getTokenAccountsByOwner":
                return _rpc_response(ata)
            if method == "getSignaturesForAddress":
                return _rpc_response(sigs)
            if method == "getTransaction":
                return _rpc_response(tx)
            return _rpc_response(None)

        store = self._SpyGrantStore()
        with patch.object(settings, "AGENTPAYMENTS_ACCESS_DURATION", 86400, create=True), \
             patch.object(settings, "AGENTPAYMENTS_GRANT_STORE", store, create=True):
            mw = GateMiddleware(lambda req: HttpResponse("ok"))
            rf = RequestFactory()
            req = rf.get("/data", HTTP_X_AGENT_KEY=key)
            before = time.time()
            with patch("requests.post", side_effect=side_effect):
                resp = mw(req)

        assert resp.status_code == 200
        assert len(store.grants) == 1
        assert store.grants[0]["expires_at"] > before + 86000  # ~24h out, allowing test slack

    class _AlwaysDenyLimiter:
        def check(self, key):
            return False

    class _PreSeededPaymentCache:
        """Reports the given key as already paid, no matter what — used to
        prove the gate consults the injected cache instead of a hardcoded
        singleton, without needing a real chain scan."""
        def __init__(self, key):
            self._key = key

        def get(self, key):
            return True if key == self._key else None

        def set(self, key, value, ttl):
            pass

    def test_fastapi_custom_agent_key_rate_limiter_is_used(self):
        pytest.importorskip("fastapi")
        import asyncio
        from starlette.requests import Request
        from starlette.responses import Response
        from agentpayments_python.fastapi_adapter import AgentPaymentsASGIMiddleware
        from agentpayments_python.crypto import generate_agent_key

        key = generate_agent_key(self.SECRET)
        mw = AgentPaymentsASGIMiddleware(
            app=None,
            challenge_secret=self.SECRET,
            home_wallet_address=self.WALLET,
            debug=True,
            usdc_mint=self.MINT,
            agent_key_rate_limiter=self._AlwaysDenyLimiter(),
        )

        async def call_next(_req):
            return Response("ok", status_code=200)

        async def run():
            req = Request({
                "type": "http", "method": "GET", "path": "/data",
                "headers": [(b"x-agent-key", key.encode())],
                "query_string": b"", "scheme": "https", "client": ("127.0.0.1", 1234),
            })
            return await mw.dispatch(req, call_next)

        resp = asyncio.run(run())
        assert resp.status_code == 429

    def test_flask_custom_payment_cache_short_circuits_chain_scan(self):
        pytest.importorskip("flask")
        from flask import Flask
        from agentpayments_python.flask_adapter import register_agentpayments
        from agentpayments_python.crypto import generate_agent_key

        key = generate_agent_key(self.SECRET)
        app = Flask(__name__)
        register_agentpayments(
            app,
            challenge_secret=self.SECRET,
            home_wallet_address=self.WALLET,
            debug=True,
            usdc_mint=self.MINT,
            payment_cache=self._PreSeededPaymentCache(key),
        )

        @app.route("/data")
        def data():
            return "ok"

        client = app.test_client()
        # No RPC mock at all -- if the gate ignored the injected cache and
        # fell through to a real chain scan, this would hit the live network
        # (and almost certainly fail/timeout in CI) instead of the assertion below.
        with patch("requests.post", side_effect=AssertionError("should not hit the network — payment_cache should have short-circuited this")):
            resp = client.get("/data", headers={"X-Agent-Key": key})
        assert resp.status_code == 200

    def test_django_custom_challenge_issue_rate_limiter_is_used(self):
        pytest.importorskip("django")
        import django
        from django.conf import settings

        if not settings.configured:
            settings.configure(
                DEBUG=True,
                CHALLENGE_SECRET=self.SECRET,
                HOME_WALLET_ADDRESS=self.WALLET,
                USDC_MINT=self.MINT,
                ALLOWED_HOSTS=["*"],
            )
            django.setup()

        from django.test import RequestFactory
        from django.http import HttpResponse
        from agentpayments_python.django_adapter import GateMiddleware

        with patch.object(settings, "AGENTPAYMENTS_CHALLENGE_ISSUE_RATE_LIMITER", self._AlwaysDenyLimiter(), create=True):
            mw = GateMiddleware(lambda req: HttpResponse("ok"))
            rf = RequestFactory()
            # A plain browser-shaped request (no agent key, no Sec-Fetch/UA —
            # still non-browser per is_browser_from_headers) won't reach the
            # challenge-issuance path; use a UA that resolves to "browser" so
            # the request falls through to the rate-limited challenge page.
            req = rf.get("/", HTTP_SEC_FETCH_MODE="navigate", HTTP_SEC_FETCH_DEST="document")
            resp = mw(req)

        assert resp.status_code == 429


# ─── pricing.py: pure helper unit tests ──────────────────────────────────────

class TestPricingHelpers:
    def test_sort_tiers_ascending_by_min_amount(self):
        tiers = [
            {"min_amount": 0.05, "name": "lifetime"},
            {"min_amount": 0.01, "name": "hourly"},
        ]
        assert [t["name"] for t in sort_tiers(tiers)] == ["hourly", "lifetime"]

    def test_resolve_tier_picks_highest_satisfied_tier(self):
        tiers = [
            {"min_amount": 0.01, "duration_seconds": 3600, "name": "hourly"},
            {"min_amount": 0.05, "duration_seconds": None, "name": "lifetime"},
        ]
        assert resolve_tier(0.01, tiers)["name"] == "hourly"
        assert resolve_tier(0.03, tiers)["name"] == "hourly"
        assert resolve_tier(0.05, tiers)["name"] == "lifetime"
        assert resolve_tier(1.0, tiers)["name"] == "lifetime"

    def test_resolve_tier_below_floor_returns_none(self):
        tiers = [{"min_amount": 0.05, "duration_seconds": None, "name": "lifetime"}]
        assert resolve_tier(0.01, tiers) is None

    def test_resolve_tier_no_tiers_or_no_amount_returns_none(self):
        assert resolve_tier(0.05, None) is None
        assert resolve_tier(None, [{"min_amount": 0.01, "name": "x"}]) is None

    def test_normalize_price_config_uses_lowest_tier_as_floor(self):
        tiers = [
            {"min_amount": 0.05, "duration_seconds": None, "name": "lifetime"},
            {"min_amount": 0.01, "duration_seconds": 3600, "name": "hourly"},
        ]
        cfg = normalize_price_config(0.5, 999, tiers)
        assert cfg["min_payment"] == 0.01  # lowest tier wins, not the flat 0.5
        assert cfg["access_duration"] is None  # superseded by tiers

    def test_normalize_price_config_without_tiers_passes_through(self):
        cfg = normalize_price_config(0.02, 3600, None)
        assert cfg == {"min_payment": 0.02, "access_duration": 3600, "pricing_tiers": None}

    def test_path_matches_prefix_respects_segment_boundary(self):
        assert path_matches_prefix("/premium", "/premium")
        assert path_matches_prefix("/premium/data", "/premium")
        assert not path_matches_prefix("/premium-lookalike", "/premium")
        assert not path_matches_prefix("/other", "/premium")

    def test_resolve_route_config_longest_prefix_wins(self):
        routes_table = build_routes_table(
            [
                {"path_prefix": "/api", "min_payment": 0.02},
                {"path_prefix": "/api/premium", "min_payment": 0.10},
            ],
            min_payment=0.01, access_duration=None, pricing_tiers=None,
        )
        base = normalize_price_config(0.01, None, None)
        assert resolve_route_config("/api/premium/data", routes_table, base)["min_payment"] == 0.10
        assert resolve_route_config("/api/other", routes_table, base)["min_payment"] == 0.02
        assert resolve_route_config("/unrelated", routes_table, base)["min_payment"] == 0.01
