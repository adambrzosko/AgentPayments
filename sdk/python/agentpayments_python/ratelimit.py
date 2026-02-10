import threading
import time

RATE_LIMIT_WINDOW = 60  # 1 minute in seconds
RATE_LIMIT_MAX = 20  # max attempts per window per key


class RateLimiter:
    def __init__(self, window: int = RATE_LIMIT_WINDOW, max_hits: int = RATE_LIMIT_MAX):
        self.window = window
        self.max_hits = max_hits
        self._hits: dict[str, tuple[float, int]] = {}
        self._lock = threading.Lock()

    def check(self, key: str) -> bool:
        now = time.time()
        with self._lock:
            entry = self._hits.get(key)
            if entry is None or now - entry[0] > self.window:
                self._hits[key] = (now, 1)
                return True
            start, count = entry
            count += 1
            self._hits[key] = (start, count)
            return count <= self.max_hits


_challenge_limiter = RateLimiter()
