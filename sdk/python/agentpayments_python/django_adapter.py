import hmac
import time

from django.conf import settings
from django.http import HttpResponse, HttpResponseRedirect, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .challenge import challenge_html
from .cookies import COOKIE_MAX_AGE, COOKIE_NAME, is_valid_cookie_value, make_cookie
from .crypto import generate_agent_key, hmac_sign, is_valid_agent_key
from .detection import is_browser_from_headers, is_public_path
from .ratelimit import _challenge_limiter
from .solana import MIN_PAYMENT, derive_payment_memo, is_valid_solana_address, verify_payment_via_backend

import json as _json
from pathlib import Path as _Path
_constants = _json.loads((_Path(__file__).resolve().parent.parent.parent / "constants.json").read_text())
MAX_NONCE_LENGTH = _constants["MAX_NONCE_LENGTH"]
MAX_RETURN_TO_LENGTH = _constants["MAX_RETURN_TO_LENGTH"]
MAX_FP_LENGTH = _constants["MAX_FP_LENGTH"]


class GateMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        secret = settings.CHALLENGE_SECRET
        if secret == "default-secret-change-me":
            import logging
            logger = logging.getLogger("agentpayments")
            if settings.DEBUG:
                logger.warning("Using default CHALLENGE_SECRET. Set a strong secret before deploying to production.")
            else:
                raise RuntimeError("CHALLENGE_SECRET is set to the insecure default. Set a strong, unique secret for production.")
        wallet_address = settings.HOME_WALLET_ADDRESS
        if wallet_address and not is_valid_solana_address(wallet_address):
            raise ValueError(f"HOME_WALLET_ADDRESS '{wallet_address}' is not a valid Solana public key (expected 32-44 base58 characters).")
        debug = settings.DEBUG
        _verify_url = getattr(settings, "AGENTPAYMENTS_VERIFY_URL", "")
        _api_key = getattr(settings, "AGENTPAYMENTS_API_KEY", "")
        network = "devnet" if debug else "mainnet-beta"

        pathname = request.path
        if is_public_path(pathname):
            return self.get_response(request)

        if pathname == "/__challenge/verify" and request.method == "POST":
            return self.get_response(request)

        headers = {
            "sec-fetch-mode": request.META.get("HTTP_SEC_FETCH_MODE"),
            "sec-fetch-dest": request.META.get("HTTP_SEC_FETCH_DEST"),
        }
        if not is_browser_from_headers(headers):
            agent_key = request.META.get("HTTP_X_AGENT_KEY")
            if not agent_key:
                new_key = generate_agent_key(secret)
                payment_memo = derive_payment_memo(new_key, secret)
                return JsonResponse({
                    "error": "payment_required",
                    "message": "Access requires a paid API key. A key has been generated for you below. Send a USDC payment with the provided memo to activate it, then retry your request with the X-Agent-Key header.",
                    "your_key": new_key,
                    "payment": {
                        "chain": "solana",
                        "network": network,
                        "token": "USDC",
                        "amount": str(MIN_PAYMENT),
                        "wallet_address": wallet_address,
                        "memo": payment_memo,
                    },
                }, status=402, json_dumps_params={"indent": 2})

            if not is_valid_agent_key(agent_key, secret):
                return JsonResponse({"error": "forbidden", "message": "Invalid API key. Keys must be issued by this server."}, status=403)

            if not wallet_address:
                return JsonResponse({"error": "server_error", "message": "Payment verification unavailable."}, status=500)

            if not _verify_url or not _api_key:
                return JsonResponse({"error": "server_error", "message": "Payment verification not configured."}, status=500)

            payment_memo = derive_payment_memo(agent_key, secret)
            paid = verify_payment_via_backend(payment_memo, wallet_address, _verify_url, _api_key, cache_key=agent_key)
            if not paid:
                return JsonResponse({
                    "error": "payment_required",
                    "message": "Key is valid but payment has not been verified yet.",
                    "your_key": agent_key,
                    "payment": {
                        "chain": "solana",
                        "network": network,
                        "token": "USDC",
                        "amount": str(MIN_PAYMENT),
                        "wallet_address": wallet_address,
                        "memo": payment_memo,
                    },
                }, status=402, json_dumps_params={"indent": 2})

            return self.get_response(request)

        cookie_val = request.COOKIES.get(COOKIE_NAME, "")
        if is_valid_cookie_value(cookie_val, secret):
            return self.get_response(request)

        nonce_ts = str(int(time.time() * 1000))
        nonce = f"{nonce_ts}.{hmac_sign(f'nonce:{nonce_ts}', secret)}"
        return HttpResponse(challenge_html(request.get_full_path(), nonce), content_type="text/html", headers={"Cache-Control": "no-store"})


@csrf_exempt
@require_POST
def challenge_verify(request):
    client_ip = request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip() or request.META.get("REMOTE_ADDR", "unknown")
    if not _challenge_limiter.check(client_ip):
        return JsonResponse({"error": "rate_limited", "message": "Too many verification attempts. Please wait and try again."}, status=429)
    secret = settings.CHALLENGE_SECRET
    nonce = request.POST.get("nonce", "")[:MAX_NONCE_LENGTH]
    return_to = request.POST.get("return_to", "/")[:MAX_RETURN_TO_LENGTH]
    fp = request.POST.get("fp", "")[:MAX_FP_LENGTH]

    i = nonce.find(".")
    if i == -1 or not fp or len(fp) < 10:
        return JsonResponse({"error": "forbidden", "message": "Challenge verification failed."}, status=403)

    nonce_ts = nonce[:i]
    nonce_sig = nonce[i + 1:]
    try:
        ts = int(nonce_ts)
    except ValueError:
        return JsonResponse({"error": "forbidden", "message": "Challenge verification failed."}, status=403)

    if int(time.time() * 1000) - ts > 300000:
        return JsonResponse({"error": "forbidden", "message": "Challenge expired. Reload the page."}, status=403)

    expected_sig = hmac_sign(f"nonce:{nonce_ts}", secret)
    if not hmac.compare_digest(nonce_sig, expected_sig):
        return JsonResponse({"error": "forbidden", "message": "Invalid challenge."}, status=403)

    safe_path = return_to if return_to.startswith("/") else "/"
    response = HttpResponseRedirect(safe_path)
    secure_cookie = request.is_secure()
    response.set_cookie(
        COOKIE_NAME,
        make_cookie(secret),
        max_age=COOKIE_MAX_AGE,
        path="/",
        httponly=True,
        secure=secure_cookie,
        samesite="Lax",
    )
    return response
