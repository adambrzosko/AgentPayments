import re as _re

def is_public_path(pathname: str) -> bool:
    return pathname == "/robots.txt" or pathname.startswith("/.well-known/")


# Sec-Fetch-* headers were introduced in Chrome 76 (2019) and Firefox 90 (2021).
# Older browsers, some mobile WebViews, and certain proxies strip them.
# This UA pattern matches common desktop/mobile browsers as a fallback so they
# get a challenge rather than a 402.
_BROWSER_UA_RE = _re.compile(
    r"(Chrome|Chromium|Firefox|Safari|Edg|OPR|Opera|SamsungBrowser|UCBrowser|Mobile Safari)"
    r"(?!/.*bot)",  # exclude UA strings that contain the browser name followed by /.*bot
    _re.IGNORECASE,
)
# Explicit bot/crawler suffixes that should NOT match even if they spoof a browser UA.
_BOT_UA_RE = _re.compile(r"bot|crawl|spider|slurp|mediapartners|adsbot", _re.IGNORECASE)


def is_browser_from_headers(headers: dict) -> bool:
    # Primary signal: Fetch metadata headers, but only the values set exclusively for
    # top-level navigations. These values are not reachable through the fetch()/XHR
    # APIs, so this doesn't just check for *presence* of the header: Node's built-in
    # fetch() (undici) unconditionally sends `sec-fetch-mode: cors` on every outgoing
    # request (not overridable, it's a forbidden header), which previously
    # misclassified fetch()-based agents as browsers and served them the HTML
    # challenge instead of the 402 JSON they need to read to pay.
    if headers.get("sec-fetch-mode") == "navigate" or headers.get("sec-fetch-dest") == "document":
        return True
    # Fallback: UA heuristic for older browsers that don't send Sec-Fetch-*, and for
    # real in-page browser fetch()/XHR calls (Sec-Fetch-Mode: cors) which still carry
    # a genuine browser User-Agent.
    ua = headers.get("user-agent") or headers.get("User-Agent") or ""
    if ua and not _BOT_UA_RE.search(ua) and _BROWSER_UA_RE.search(ua):
        return True
    return False
