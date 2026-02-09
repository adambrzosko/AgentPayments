import time

from flask import jsonify, make_response, redirect, request

from .challenge import challenge_html
from .cookies import COOKIE_MAX_AGE, COOKIE_NAME, is_valid_cookie_value, make_cookie
from .crypto import generate_agent_key, hmac_sign, is_valid_agent_key
from .detection import is_browser_from_headers, is_public_path
from .solana import MIN_PAYMENT, RPC_DEVNET, RPC_MAINNET, USDC_MINT_DEVNET, USDC_MINT_MAINNET, verify_payment_on_chain


def register_agentpayments(app, *, challenge_secret: str, home_wallet_address: str, debug: bool = True, solana_rpc_url: str = "", usdc_mint: str = ""):
    rpc_url = solana_rpc_url or (RPC_DEVNET if debug else RPC_MAINNET)
    mint = usdc_mint or (USDC_MINT_DEVNET if debug else USDC_MINT_MAINNET)

    @app.before_request
    def _gate():
        path = request.path
        if is_public_path(path):
            return None
        if path == "/__challenge/verify" and request.method == "POST":
            return None

        if not is_browser_from_headers(request.headers):
            key = request.headers.get("X-Agent-Key")
            network = "devnet" if debug else "mainnet-beta"
            if not key:
                new_key = generate_agent_key(challenge_secret)
                return jsonify({"error": "payment_required", "your_key": new_key, "payment": {"chain": "solana", "network": network, "token": "USDC", "amount": str(MIN_PAYMENT), "wallet_address": home_wallet_address, "memo": new_key}}), 402
            if not is_valid_agent_key(key, challenge_secret):
                return jsonify({"error": "forbidden", "message": "Invalid API key."}), 403
            if not home_wallet_address:
                return jsonify({"error": "server_error", "message": "Payment verification unavailable."}), 500
            if not verify_payment_on_chain(key, home_wallet_address, rpc_url, mint):
                return jsonify({"error": "payment_required", "your_key": key}), 402
            return None

        cookie_val = request.cookies.get(COOKIE_NAME, "")
        if is_valid_cookie_value(cookie_val, challenge_secret):
            return None

        nonce_ts = str(int(time.time() * 1000))
        nonce = f"{nonce_ts}.{hmac_sign(f'nonce:{nonce_ts}', challenge_secret)}"
        return make_response(challenge_html(request.full_path or request.path, nonce), 200, {"Content-Type": "text/html", "Cache-Control": "no-store"})

    @app.post("/__challenge/verify")
    def _verify():
        nonce = request.form.get("nonce", "")
        return_to = request.form.get("return_to", "/")
        fp = request.form.get("fp", "")
        i = nonce.find(".")
        if i == -1 or not fp or len(fp) < 10:
            return jsonify({"error": "forbidden", "message": "Challenge verification failed."}), 403
        nonce_ts = nonce[:i]
        nonce_sig = nonce[i + 1:]
        try:
            ts = int(nonce_ts)
        except ValueError:
            return jsonify({"error": "forbidden", "message": "Challenge verification failed."}), 403
        if int(time.time() * 1000) - ts > 300000:
            return jsonify({"error": "forbidden", "message": "Challenge expired."}), 403
        if nonce_sig != hmac_sign(f"nonce:{nonce_ts}", challenge_secret):
            return jsonify({"error": "forbidden", "message": "Invalid challenge."}), 403
        safe = return_to if return_to.startswith("/") else "/"
        resp = redirect(safe, code=302)
        resp.set_cookie(COOKIE_NAME, make_cookie(challenge_secret), max_age=COOKIE_MAX_AGE, path='/', httponly=True, secure=True, samesite='Lax')
        return resp
