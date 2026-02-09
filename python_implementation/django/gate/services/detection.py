def is_public_path(pathname: str) -> bool:
    """Check if the path should bypass the gate."""
    if pathname == "/robots.txt":
        return True
    if pathname.startswith("/.well-known/"):
        return True
    return False


def is_browser(request) -> bool:
    """Detect browser requests via Sec-Fetch headers."""
    sec_fetch_mode = request.META.get("HTTP_SEC_FETCH_MODE")
    sec_fetch_dest = request.META.get("HTTP_SEC_FETCH_DEST")
    return bool(sec_fetch_mode or sec_fetch_dest)
