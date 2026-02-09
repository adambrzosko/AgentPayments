import logging
import time

from django.conf import settings
from django.http import JsonResponse

from .services.challenge import challenge_page
from .services.cookies import is_valid_cookie
from .services.crypto import generate_agent_key, hmac_sign, is_valid_agent_key
from .services.detection import is_browser, is_public_path
from .services.solana import (
    MIN_PAYMENT,
    RPC_DEVNET,
    RPC_MAINNET,
    USDC_MINT_DEVNET,
    USDC_MINT_MAINNET,
    verify_payment_on_chain,
)

logger = logging.getLogger(__name__)


class GateMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        secret = settings.CHALLENGE_SECRET
        wallet_address = settings.HOME_WALLET_ADDRESS
        debug = settings.DEBUG
        rpc_url = settings.SOLANA_RPC_URL or (RPC_DEVNET if debug else RPC_MAINNET)
        usdc_mint = settings.USDC_MINT or (USDC_MINT_DEVNET if debug else USDC_MINT_MAINNET)
        network = "devnet" if debug else "mainnet"

        pathname = request.path

        # 1. Public paths -> pass through
        if is_public_path(pathname):
            return self.get_response(request)

        # 2. Challenge verify POST -> pass through to view
        if pathname == "/__challenge/verify" and request.method == "POST":
            return self.get_response(request)

        # 3. Non-browser requests (agent flow)
        if not is_browser(request):
            agent_key = request.META.get("HTTP_X_AGENT_KEY")

            # No key -> generate one, return 402
            if not agent_key:
                new_key = generate_agent_key(secret)
                return JsonResponse(
                    {
                        "error": "payment_required",
                        "message": (
                            "Access requires a paid API key. A key has been generated for you below. "
                            "Send a USDC payment on Solana with this key as the memo to activate it, "
                            "then retry your request with the X-Agent-Key header."
                        ),
                        "your_key": new_key,
                        "payment": {
                            "chain": "solana",
                            "network": network + "-beta" if network == "mainnet" else network,
                            "token": "USDC",
                            "amount": str(MIN_PAYMENT),
                            "wallet_address": wallet_address,
                            "memo": new_key,
                            "instructions": (
                                f"Send {MIN_PAYMENT} USDC on Solana {network} to "
                                f"{wallet_address} with memo \"{new_key}\". "
                                f"Then include the header X-Agent-Key: {new_key} "
                                "on all subsequent requests."
                            ),
                        },
                    },
                    status=402,
                    json_dumps_params={"indent": 2},
                )

            # Invalid key -> 403
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

            # No wallet configured -> 500
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

            # Verify payment on-chain
            paid = verify_payment_on_chain(agent_key, wallet_address, rpc_url, usdc_mint)

            if not paid:
                return JsonResponse(
                    {
                        "error": "payment_required",
                        "message": (
                            "Key is valid but payment has not been verified on-chain yet. "
                            "Please send the USDC payment and allow a few moments for confirmation."
                        ),
                        "your_key": agent_key,
                        "payment": {
                            "chain": "solana",
                            "network": network + "-beta" if network == "mainnet" else network,
                            "token": "USDC",
                            "amount": str(MIN_PAYMENT),
                            "wallet_address": wallet_address,
                            "memo": agent_key,
                        },
                    },
                    status=402,
                    json_dumps_params={"indent": 2},
                )

            # Payment verified -> grant access
            ua = request.META.get("HTTP_USER_AGENT", "unknown")
            ip = request.META.get("REMOTE_ADDR", "unknown")
            logger.info(
                "[gate] Payment verified (%s) -- agent access granted: key=%s... ua=%s ip=%s path=%s",
                network, agent_key[:12], ua, ip, pathname,
            )
            return self.get_response(request)

        # 4. Browser flow
        if is_valid_cookie(request, secret):
            return self.get_response(request)

        # No valid cookie -> serve challenge page
        nonce_ts = str(int(time.time() * 1000))
        nonce_sig = hmac_sign(f"nonce:{nonce_ts}", secret)
        nonce = f"{nonce_ts}.{nonce_sig}"
        return challenge_page(request.get_full_path(), nonce)
