import sys
from pathlib import Path

# Ensure the SDK package is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agentpayments_python.crypto import hmac_sign, generate_agent_key, is_valid_agent_key
from agentpayments_python.detection import is_public_path, is_browser_from_headers
from agentpayments_python.cookies import make_cookie, is_valid_cookie_value
from agentpayments_python.challenge import challenge_html
from agentpayments_python.ratelimit import RateLimiter

SECRET = "test-secret-python"


class TestHmacSign:
    def test_deterministic(self):
        a = hmac_sign("hello", SECRET)
        b = hmac_sign("hello", SECRET)
        assert a == b
        assert len(a) == 64
        assert all(c in "0123456789abcdef" for c in a)

    def test_different_secret(self):
        a = hmac_sign("hello", SECRET)
        b = hmac_sign("hello", "other")
        assert a != b


class TestAgentKey:
    def test_format(self):
        key = generate_agent_key(SECRET)
        assert key.startswith("ag_")
        parts = key[3:].split("_")
        assert len(parts) == 2
        assert len(parts[0]) == 16
        assert len(parts[1]) == 16

    def test_roundtrip(self):
        key = generate_agent_key(SECRET)
        assert is_valid_agent_key(key, SECRET) is True

    def test_tampered(self):
        key = generate_agent_key(SECRET)
        tampered = key[:-1] + ("1" if key[-1] == "0" else "0")
        assert is_valid_agent_key(tampered, SECRET) is False

    def test_wrong_secret(self):
        key = generate_agent_key(SECRET)
        assert is_valid_agent_key(key, "wrong") is False

    def test_empty_null(self):
        assert is_valid_agent_key("", SECRET) is False
        assert is_valid_agent_key(None, SECRET) is False


class TestDetection:
    def test_public_paths(self):
        assert is_public_path("/robots.txt") is True
        assert is_public_path("/.well-known/agent-access.json") is True
        assert is_public_path("/.well-known/foo") is True

    def test_non_public_paths(self):
        assert is_public_path("/api/data") is False
        assert is_public_path("/") is False

    def test_browser_with_sec_fetch(self):
        assert is_browser_from_headers({"sec-fetch-mode": "navigate"}) is True
        assert is_browser_from_headers({"sec-fetch-dest": "document"}) is True

    def test_agent_without_sec_fetch(self):
        assert is_browser_from_headers({}) is False
        assert is_browser_from_headers({"user-agent": "bot/1"}) is False


class TestCookies:
    def test_roundtrip(self):
        cookie = make_cookie(SECRET)
        assert is_valid_cookie_value(cookie, SECRET) is True

    def test_tampered(self):
        cookie = make_cookie(SECRET)
        tampered = cookie[:-1] + ("1" if cookie[-1] == "0" else "0")
        assert is_valid_cookie_value(tampered, SECRET) is False

    def test_empty(self):
        assert is_valid_cookie_value("", SECRET) is False
        assert is_valid_cookie_value(None, SECRET) is False


class TestChallenge:
    def test_returns_html(self):
        html = challenge_html("/test", "123.abc")
        assert "<!DOCTYPE html" in html
        assert "123.abc" in html
        assert "/test" in html

    def test_sanitizes_return_to(self):
        html = challenge_html("https://evil.com", "123.abc")
        assert '"/"' in html


class TestRateLimiter:
    def test_allows_up_to_max(self):
        limiter = RateLimiter(window=60, max_hits=3)
        assert limiter.check("ip1") is True
        assert limiter.check("ip1") is True
        assert limiter.check("ip1") is True

    def test_blocks_after_max(self):
        limiter = RateLimiter(window=60, max_hits=2)
        limiter.check("ip1")
        limiter.check("ip1")
        assert limiter.check("ip1") is False
