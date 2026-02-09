import json
import time
from urllib.parse import urlencode

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from .challenge import challenge_html
from .cookies import COOKIE_MAX_AGE, COOKIE_NAME, is_valid_cookie_value, make_cookie
from .crypto import generate_agent_key, hmac_sign, is_valid_agent_key
from .detection import is_browser_from_headers, is_public_path
from .solana import MIN_PAYMENT, RPC_DEVNET, RPC_MAINNET, USDC_MINT_DEVNET, USDC_MINT_MAINNET, verify_payment_on_chain


class AgentPaymentsASGIMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, *, challenge_secret: str, home_wallet_address: str, debug: bool = True, solana_rpc_url: str = "", usdc_mint: str = ""):
        super().__init__(app)
        self.challenge_secret = challenge_secret
        self.home_wallet_address = home_wallet_address
        self.debug = debug
        self.solana_rpc_url = solana_rpc_url or (RPC_DEVNET if debug else RPC_MAINNET)
        self.usdc_mint = usdc_mint or (USDC_MINT_DEVNET if debug else USDC_MINT_MAINNET)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if is_public_path(path):
            return await call_next(request)

        if path == "/__challenge/verify" and request.method == "POST":
            return await call_next(request)

        if not is_browser_from_headers(dict(request.headers)):
            agent_key = request.headers.get("x-agent-key")
            network = "devnet" if self.debug else "mainnet-beta"
            if not agent_key:
                new_key = generate_agent_key(self.challenge_secret)
                return JSONResponse({
                    "error": "payment_required",
                    "your_key": new_key,
                    "payment": {"chain": "solana", "network": network, "token": "USDC", "amount": str(MIN_PAYMENT), "wallet_address": self.home_wallet_address, "memo": new_key},
                }, status_code=402)

            if not is_valid_agent_key(agent_key, self.challenge_secret):
                return JSONResponse({"error": "forbidden", "message": "Invalid API key."}, status_code=403)

            if not self.home_wallet_address:
                return JSONResponse({"error": "server_error", "message": "Payment verification unavailable."}, status_code=500)

            if not verify_payment_on_chain(agent_key, self.home_wallet_address, self.solana_rpc_url, self.usdc_mint):
                return JSONResponse({"error": "payment_required", "your_key": agent_key}, status_code=402)

            return await call_next(request)

        cookie_val = request.cookies.get(COOKIE_NAME, "")
        if is_valid_cookie_value(cookie_val, self.challenge_secret):
            return await call_next(request)

        nonce_ts = str(int(time.time() * 1000))
        nonce = f"{nonce_ts}.{hmac_sign(f'nonce:{nonce_ts}', self.challenge_secret)}"
        return HTMLResponse(challenge_html(str(request.url.path), nonce), headers={"Cache-Control": "no-store"})


async def challenge_verify_endpoint(request: Request, challenge_secret: str):
    form = await request.form()
    nonce = str(form.get("nonce", ""))
    return_to = str(form.get("return_to", "/"))
    fp = str(form.get("fp", ""))

    i = nonce.find(".")
    if i == -1 or not fp or len(fp) < 10:
        return JSONResponse({"error": "forbidden", "message": "Challenge verification failed."}, status_code=403)

    nonce_ts = nonce[:i]
    nonce_sig = nonce[i + 1:]
    try:
        ts = int(nonce_ts)
    except ValueError:
        return JSONResponse({"error": "forbidden", "message": "Challenge verification failed."}, status_code=403)

    if int(time.time() * 1000) - ts > 300000:
        return JSONResponse({"error": "forbidden", "message": "Challenge expired."}, status_code=403)

    if nonce_sig != hmac_sign(f"nonce:{nonce_ts}", challenge_secret):
        return JSONResponse({"error": "forbidden", "message": "Invalid challenge."}, status_code=403)

    safe_path = return_to if return_to.startswith("/") else "/"
    resp = RedirectResponse(url=safe_path, status_code=302)
    resp.set_cookie(COOKIE_NAME, make_cookie(challenge_secret), max_age=COOKIE_MAX_AGE, path="/", httponly=True, secure=True, samesite="lax")
    return resp
