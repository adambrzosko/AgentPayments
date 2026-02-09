import hmac as hmac_module
import time

from .crypto import hmac_sign

COOKIE_NAME = "__agp_verified"
COOKIE_MAX_AGE = 86400


def is_valid_cookie(request, secret: str) -> bool:
    cookie = request.COOKIES.get(COOKIE_NAME)
    if not cookie:
        return False
    dot_idx = cookie.find(".")
    if dot_idx == -1:
        return False
    timestamp_str = cookie[:dot_idx]
    signature = cookie[dot_idx + 1:]
    try:
        ts = int(timestamp_str)
    except ValueError:
        return False
    now_ms = int(time.time() * 1000)
    if now_ms - ts > COOKIE_MAX_AGE * 1000:
        return False
    expected = hmac_sign(timestamp_str, secret)
    return hmac_module.compare_digest(signature, expected)


def make_challenge_cookie(secret: str) -> str:
    now_ms = str(int(time.time() * 1000))
    sig = hmac_sign(now_ms, secret)
    return f"{now_ms}.{sig}"
