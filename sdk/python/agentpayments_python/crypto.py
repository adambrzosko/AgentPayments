import hashlib
import hmac
import json
import uuid
from pathlib import Path

_constants = json.loads((Path(__file__).resolve().parent.parent.parent / "constants.json").read_text())
KEY_PREFIX = _constants["KEY_PREFIX"]
MAX_KEY_LENGTH = _constants["MAX_KEY_LENGTH"]


def hmac_sign(data: str, secret: str) -> str:
    return hmac.new(secret.encode(), data.encode(), hashlib.sha256).hexdigest()


def generate_agent_key(secret: str) -> str:
    random_part = uuid.uuid4().hex[:16]
    sig = hmac_sign(random_part, secret)
    return f"{KEY_PREFIX}{random_part}_{sig[:16]}"


def is_valid_agent_key(key: str, secret: str) -> bool:
    if not key or len(key) > MAX_KEY_LENGTH or not key.startswith(KEY_PREFIX):
        return False
    rest = key[len(KEY_PREFIX):]
    i = rest.find("_")
    if i == -1:
        return False
    random_part = rest[:i]
    sig = rest[i + 1:]
    expected = hmac_sign(random_part, secret)
    return hmac.compare_digest(sig, expected[:16])
