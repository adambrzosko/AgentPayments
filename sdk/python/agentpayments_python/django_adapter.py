import time

from django.conf import settings
from django.http import HttpResponse, HttpResponseRedirect, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .challenge import challenge_html
from .cookies import COOKIE_MAX_AGE, COOKIE_NAME, is_valid_cookie_value, make_cookie
from .crypto import generate_agent_key, hmac_sign, is_valid_agent_key
from .detection import is_browser_from_headers, is_public_path
from .solana import MIN_PAYMENT, RPC_DEVNET, RPC_MAINNET, USDC_MINT_DEVNET, USDC_MINT_MAINNET, verify_payment_on_chain


class GateMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        secret = settings.CHALLENGE_SECRET
        wallet_address = settings.HOME_WALLET_ADDRESS
        debug = settings.DEBUG
        rpc_url = settings.SOLANA_RPC_URL or (RPC_DEVNET if debug else RPC_MAINNET)
        usdc_mint = settings.USDC_MINT or (USDC_MINT_DEVNET if debug else USDC_MINT_MAINNET)
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
                return JsonResponse({
                    "error": "payment_required",
                    "message": "Access requires a paid API key. A key has been generated for you below. Send a USDC payment on Solana with this key as the memo to activate it, then retry your request with the X-Agent-Key header.",
                    "your_key": new_key,
                    "payment": {
                        "chain": "solana",
                        "network": network,
                        "token": "USDC",
                        "amount": str(MIN_PAYMENT),
                        "wallet_address": wallet_address,
                        "memo": new_key,
                    },
                }, status=402, json_dumps_params={"indent": 2})

            if not is_valid_agent_key(agent_key, secret):
                return JsonResponse({"error": "forbidden", "message": "Invalid API key. Keys must be issued by this server."}, status=403)

            if not wallet_address:
                return JsonResponse({"error": "server_error", "message": "Payment verification unavailable."}, status=500)

            paid = verify_payment_on_chain(agent_key, wallet_address, rpc_url, usdc_mint)
            if not paid:
                return JsonResponse({
                    "error": "payment_required",
                    "message": "Key is valid but payment has not been verified on-chain yet.",
                    "your_key": agent_key,
                    "payment": {
                        "chain": "solana",
                        "network": network,
                        "token": "USDC",
                        "amount": str(MIN_PAYMENT),
                        "wallet_address": wallet_address,
                        "memo": agent_key,
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
    secret = settings.CHALLENGE_SECRET
    nonce = request.POST.get("nonce", "")
    return_to = request.POST.get("return_to", "/")
    fp = request.POST.get("fp", "")

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
    if nonce_sig != expected_sig:
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
