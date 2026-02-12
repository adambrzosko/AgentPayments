import hashlib
import hmac as _hmac
import logging

import requests

logger = logging.getLogger(__name__)

MIN_PAYMENT = 0.01


def derive_payment_memo(agent_key: str, secret: str) -> str:
    sig = _hmac.new(secret.encode(), agent_key.encode(), hashlib.sha256).hexdigest()
    return f"gm_{sig[:16]}"


def verify_payment_via_backend(
    memo: str, wallet_address: str, verify_url: str, api_key: str
) -> bool:
    try:
        resp = requests.get(
            verify_url,
            params={"memo": memo, "wallet": wallet_address},
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("paid") is True
    except Exception:
        logger.exception("[gate] Backend verification error")
    return False
