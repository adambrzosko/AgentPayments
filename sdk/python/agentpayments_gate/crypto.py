import hashlib
import hmac as hmac_module
import uuid

KEY_PREFIX = "ag_"


def hmac_sign(data: str, secret: str) -> str:
    return hmac_module.new(
        secret.encode("utf-8"),
        data.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def generate_agent_key(secret: str) -> str:
    random_part = uuid.uuid4().hex[:16]
    sig = hmac_sign(random_part, secret)
    return f"{KEY_PREFIX}{random_part}_{sig[:16]}"


def is_valid_agent_key(key: str, secret: str) -> bool:
    if not key.startswith(KEY_PREFIX):
        return False
    rest = key[len(KEY_PREFIX):]
    underscore_idx = rest.find("_")
    if underscore_idx == -1:
        return False
    random_part = rest[:underscore_idx]
    sig = rest[underscore_idx + 1:]
    expected = hmac_sign(random_part, secret)
    return hmac_module.compare_digest(sig, expected[:16])
