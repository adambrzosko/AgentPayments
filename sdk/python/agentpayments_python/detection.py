def is_public_path(pathname: str) -> bool:
    return pathname == "/robots.txt" or pathname.startswith("/.well-known/")


def is_browser_from_headers(headers: dict) -> bool:
    return bool(headers.get("sec-fetch-mode") or headers.get("sec-fetch-dest"))
