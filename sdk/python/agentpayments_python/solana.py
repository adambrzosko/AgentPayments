import hashlib
import hmac as _hmac
import json
import logging
import re
import threading
import time as _time
from collections import OrderedDict
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

PAYMENT_CACHE_TTL = 10 * 60  # 10 minutes in seconds
PAYMENT_CACHE_MAX = 1000

_constants = json.loads((Path(__file__).resolve().parent.parent.parent / "constants.json").read_text())
MIN_PAYMENT = _constants["MIN_PAYMENT"]

BASE58_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")


class _PaymentCache:
    def __init__(self, ttl: int = PAYMENT_CACHE_TTL, max_size: int = PAYMENT_CACHE_MAX):
        self.ttl = ttl
        self.max_size = max_size
        self._cache: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> bool:
        with self._lock:
            ts = self._cache.get(key)
            if ts is None:
                return False
            if _time.time() - ts > self.ttl:
                del self._cache[key]
                return False
            return True

    def set(self, key: str) -> None:
        with self._lock:
            if len(self._cache) >= self.max_size:
                self._cache.popitem(last=False)
            self._cache[key] = _time.time()


_payment_cache = _PaymentCache()


def is_valid_solana_address(address: str) -> bool:
    return bool(address and BASE58_RE.match(address))


def derive_payment_memo(agent_key: str, secret: str) -> str:
    sig = _hmac.new(secret.encode(), agent_key.encode(), hashlib.sha256).hexdigest()
    return f"gm_{sig[:16]}"


def verify_payment_via_backend(
    memo: str, verify_url: str, api_key: str, *, cache_key: str = ""
) -> bool:
    _cache_key = cache_key or memo
    if _payment_cache.get(_cache_key):
        return True
    try:
        resp = requests.get(
            verify_url,
            params={"memo": memo},
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("paid") is True:
            _payment_cache.set(_cache_key)
            return True
    except Exception:
        logger.exception("[gate] Backend verification error")
    return False


_merchant_config_cache: dict[str, dict] = {}


def fetch_merchant_config(verify_url: str, api_key: str) -> dict:
    """Fetch wallet address and network from verify_service. Cached per api_key."""
    cached = _merchant_config_cache.get(api_key)
    if cached:
        return cached
    base_url = re.sub(r"/verify/?$", "", verify_url)
    resp = requests.get(
        f"{base_url}/merchants/me",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=10,
    )
    resp.raise_for_status()
    config = resp.json()
    _merchant_config_cache[api_key] = config
    return config
