import logging
import time

from django.conf import settings
from django.http import HttpResponseRedirect, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .challenge import challenge_page
from .cookies import COOKIE_MAX_AGE, COOKIE_NAME, is_valid_cookie
from .crypto import generate_agent_key, hmac_sign, is_valid_agent_key
from .detection import is_browser, is_public_path
from .solana import (
    MIN_PAYMENT,
    derive_payment_memo,
    verify_payment_via_backend,
)

logger = logging.getLogger(__name__)


class GateMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        secret = settings.CHALLENGE_SECRET
        wallet_address = settings.HOME_WALLET_ADDRESS
        debug = settings.DEBUG
        _verify_url = getattr(settings, "AGENTPAYMENTS_VERIFY_URL", "")
        _gate_secret = getattr(settings, "AGENTPAYMENTS_GATE_SECRET", "")
        network = "devnet" if debug else "mainnet"

        pathname = request.path

        if is_public_path(pathname):
            return self.get_response(request)

        if pathname == "/__challenge/verify" and request.method == "POST":
            return self.get_response(request)

        if not is_browser(request):
            agent_key = request.META.get("HTTP_X_AGENT_KEY")

            if not agent_key:
                new_key = generate_agent_key(secret)
                payment_memo = derive_payment_memo(new_key, secret)
                return JsonResponse(
                    {
                        "error": "payment_required",
                        "message": (
                            "Access requires a paid API key. A key has been generated for you below. "
                            "Send a USDC payment with the provided memo to activate it, "
                            "then retry your request with the X-Agent-Key header."
                        ),
                        "your_key": new_key,
                        "payment": {
                            "chain": "solana",
                            "network": network + "-beta" if network == "mainnet" else network,
                            "token": "USDC",
                            "amount": str(MIN_PAYMENT),
                            "wallet_address": wallet_address,
                            "memo": payment_memo,
                            "instructions": (
                                f"Send {MIN_PAYMENT} USDC on Solana {network} to "
                                f"{wallet_address} with memo \"{payment_memo}\". "
                                f"Then include the header X-Agent-Key: {new_key} "
                                "on all subsequent requests."
                            ),
                        },
                    },
                    status=402,
                    json_dumps_params={"indent": 2},
                )

            if not is_valid_agent_key(agent_key, secret):
                return JsonResponse(
                    {
                        "error": "forbidden",
                        "message": "Invalid API key. Keys must be issued by this server.",
                        "details": "GET /.well-known/agent-access.json for access instructions.",
                    },
                    status=403,
                    json_dumps_params={"indent": 2},
                )

            if not wallet_address:
                logger.error("[gate] HOME_WALLET_ADDRESS not set, cannot verify payments")
                return JsonResponse(
                    {
                        "error": "server_error",
                        "message": "Payment verification unavailable.",
                    },
                    status=500,
                    json_dumps_params={"indent": 2},
                )

            if not _verify_url or not _gate_secret:
                return JsonResponse(
                    {
                        "error": "server_error",
                        "message": "Payment verification not configured.",
                    },
                    status=500,
                    json_dumps_params={"indent": 2},
                )

            payment_memo = derive_payment_memo(agent_key, secret)
            paid = verify_payment_via_backend(payment_memo, wallet_address, _verify_url, _gate_secret, cache_key=agent_key)

            if not paid:
                return JsonResponse(
                    {
                        "error": "payment_required",
                        "message": (
                            "Key is valid but payment has not been verified yet. "
                            "Please send the USDC payment and allow a few moments for confirmation."
                        ),
                        "your_key": agent_key,
                        "payment": {
                            "chain": "solana",
                            "network": network + "-beta" if network == "mainnet" else network,
                            "token": "USDC",
                            "amount": str(MIN_PAYMENT),
                            "wallet_address": wallet_address,
                            "memo": payment_memo,
                        },
                    },
                    status=402,
                    json_dumps_params={"indent": 2},
                )

            ua = request.META.get("HTTP_USER_AGENT", "unknown")
            ip = request.META.get("REMOTE_ADDR", "unknown")
            logger.info(
                "[gate] Payment verified (%s) -- agent access granted: key=%s... ua=%s ip=%s path=%s",
                network, agent_key[:12], ua, ip, pathname,
            )
            return self.get_response(request)

        if is_valid_cookie(request, secret):
            return self.get_response(request)

        nonce_ts = str(int(time.time() * 1000))
        nonce_sig = hmac_sign(f"nonce:{nonce_ts}", secret)
        nonce = f"{nonce_ts}.{nonce_sig}"
        return challenge_page(request.get_full_path(), nonce)


@csrf_exempt
@require_POST
def challenge_verify(request):
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

    safe_path = return_to if return_to.startswith("/") else "/"

    now = str(int(time.time() * 1000))
    cookie_sig = hmac_sign(now, secret)
    cookie_value = f"{now}.{cookie_sig}"

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
