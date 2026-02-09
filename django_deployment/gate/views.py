import json
import time
from pathlib import Path
from urllib.parse import quote as url_quote

from django.conf import settings
from django.http import HttpResponse, HttpResponseRedirect, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .services.cookies import COOKIE_MAX_AGE, COOKIE_NAME, make_challenge_cookie
from .services.crypto import hmac_sign

STATIC_DIR = Path(settings.BASE_DIR) / "static"


@csrf_exempt
@require_POST
def challenge_verify(request):
    """Handle the browser challenge form submission."""
    secret = settings.CHALLENGE_SECRET

    nonce = request.POST.get("nonce", "")
    return_to = request.POST.get("return_to", "/")
    fp = request.POST.get("fp", "")

    dot_idx = nonce.find(".")
    if dot_idx == -1 or not fp or len(fp) < 10:
        return JsonResponse(
            {"error": "forbidden", "message": "Challenge verification failed."},
            status=403,
            json_dumps_params={"indent": 2},
        )

    nonce_ts = nonce[:dot_idx]
    nonce_sig = nonce[dot_idx + 1:]

    try:
        ts = int(nonce_ts)
    except ValueError:
        return JsonResponse(
            {"error": "forbidden", "message": "Challenge verification failed."},
            status=403,
            json_dumps_params={"indent": 2},
        )

    # Nonce expires after 5 minutes (300,000 ms)
    now_ms = int(time.time() * 1000)
    if now_ms - ts > 300_000:
        return JsonResponse(
            {"error": "forbidden", "message": "Challenge expired. Reload the page."},
            status=403,
            json_dumps_params={"indent": 2},
        )

    expected_sig = hmac_sign(f"nonce:{nonce_ts}", secret)
    if nonce_sig != expected_sig:
        return JsonResponse(
            {"error": "forbidden", "message": "Invalid challenge."},
            status=403,
            json_dumps_params={"indent": 2},
        )

    # Success: set cookie and redirect
    safe_path = return_to if return_to.startswith("/") else "/"
    cookie_value = make_challenge_cookie(secret)

    response = HttpResponseRedirect(safe_path)
    response.set_cookie(
        COOKIE_NAME,
        cookie_value,
        max_age=COOKIE_MAX_AGE,
        path="/",
        httponly=True,
        secure=True,
        samesite="Lax",
    )
    return response


def serve_index(request):
    """Serve the gated content page."""
    index_path = STATIC_DIR / "index.html"
    try:
        content = index_path.read_text()
    except FileNotFoundError:
        return HttpResponse("Not found", status=404)
    return HttpResponse(content, content_type="text/html")


def serve_robots_txt(request):
    """Serve robots.txt."""
    robots_path = STATIC_DIR / "robots.txt"
    try:
        content = robots_path.read_text()
    except FileNotFoundError:
        return HttpResponse("Not found", status=404)
    return HttpResponse(content, content_type="text/plain")


def serve_agent_access_json(request):
    """Serve the agent access protocol document."""
    json_path = STATIC_DIR / ".well-known" / "agent-access.json"
    try:
        content = json_path.read_text()
    except FileNotFoundError:
        return HttpResponse("Not found", status=404)
    return HttpResponse(content, content_type="application/json")
