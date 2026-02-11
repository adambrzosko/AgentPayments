import hmac
import json
import time
from pathlib import Path

from .crypto import hmac_sign

_constants = json.loads((Path(__file__).resolve().parent.parent.parent / "constants.json").read_text())
COOKIE_NAME = _constants["COOKIE_NAME"]
COOKIE_MAX_AGE = _constants["COOKIE_MAX_AGE"]


def make_cookie(secret: str) -> str:
    now_ms = str(int(time.time() * 1000))
    return f"{now_ms}.{hmac_sign(now_ms, secret)}"


def is_valid_cookie_value(cookie_value: str, secret: str) -> bool:
    if not cookie_value:
        return False
    i = cookie_value.find(".")
    if i == -1:
        return False
    ts_str = cookie_value[:i]
    sig = cookie_value[i + 1:]
    try:
        ts = int(ts_str)
    except ValueError:
        return False
    if int(time.time() * 1000) - ts > COOKIE_MAX_AGE * 1000:
        return False
    expected = hmac_sign(ts_str, secret)
    return hmac.compare_digest(sig, expected)
