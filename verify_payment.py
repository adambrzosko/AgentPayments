#!/usr/bin/env python3
"""
Verify that a USDC payment was made on Solana for a given agent key.

Usage:
    python verify_payment.py <wallet_address> <agent_key>
    python verify_payment.py --env <agent_key>        # reads HOME_WALLET_ADDRESS from .env

Requires: pip install requests
"""

import sys
import os
import json
import requests

DEBUG = os.environ.get("DEBUG", "true").lower() != "false"

USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
RPC_DEVNET = "https://api.devnet.solana.com"
RPC_MAINNET = "https://api.mainnet-beta.solana.com"

SOLANA_RPC = os.environ.get("SOLANA_RPC_URL", RPC_DEVNET if DEBUG else RPC_MAINNET)
USDC_MINT = os.environ.get("USDC_MINT", USDC_MINT_DEVNET if DEBUG else USDC_MINT_MAINNET)
MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
MIN_PAYMENT = 0.01


def rpc_call(method: str, params: list) -> dict:
    resp = requests.post(
        SOLANA_RPC,
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def get_recent_signatures(wallet_address: str, limit: int = 50) -> list:
    data = rpc_call("getSignaturesForAddress", [wallet_address, {"limit": limit}])
    return data.get("result", [])


def get_transaction(signature: str) -> dict | None:
    data = rpc_call(
        "getTransaction",
        [signature, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}],
    )
    return data.get("result")


def verify_payment(wallet_address: str, agent_key: str) -> tuple[bool, str | None]:
    """
    Scan recent transactions to wallet_address for a USDC payment
    with agent_key as the memo.

    Returns (verified, transaction_signature).
    """
    sigs = get_recent_signatures(wallet_address)
    print(f"Scanning {len(sigs)} recent transactions...")

    for sig_info in sigs:
        if sig_info.get("err"):
            continue

        sig = sig_info["signature"]
        tx = get_transaction(sig)
        if not tx:
            continue

        instructions = tx.get("transaction", {}).get("message", {}).get("instructions", [])
        inner = tx.get("meta", {}).get("innerInstructions", [])
        all_ix = list(instructions)
        for group in inner:
            all_ix.extend(group.get("instructions", []))

        has_memo = False
        has_payment = False

        for ix in all_ix:
            # Check memo
            program = ix.get("program", "")
            program_id = ix.get("programId", "")
            if program == "spl-memo" or program_id == MEMO_PROGRAM:
                parsed = ix.get("parsed", "")
                memo_text = parsed if isinstance(parsed, str) else str(parsed)
                if agent_key in memo_text:
                    has_memo = True

            # Check USDC transfer
            if program == "spl-token":
                parsed = ix.get("parsed", {})
                tx_type = parsed.get("type", "")
                if tx_type in ("transfer", "transferChecked"):
                    info = parsed.get("info", {})

                    # For transferChecked, verify it's USDC
                    if tx_type == "transferChecked" and info.get("mint") != USDC_MINT:
                        continue

                    # Parse amount
                    token_amount = info.get("tokenAmount", {})
                    ui_amount = token_amount.get("uiAmount")
                    if ui_amount is None:
                        raw = info.get("amount", "0")
                        ui_amount = int(raw) / 1e6

                    if ui_amount >= MIN_PAYMENT:
                        has_payment = True

        if has_memo and has_payment:
            return True, sig

    return False, None


def load_env_file(path: str = ".env") -> dict:
    """Load key=value pairs from a .env file."""
    env = {}
    if not os.path.exists(path):
        return env
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("\"'")
    return env


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip())
        sys.exit(1)

    if sys.argv[1] == "--env":
        if len(sys.argv) < 3:
            print("Usage: python verify_payment.py --env <agent_key>")
            sys.exit(1)
        env = load_env_file()
        wallet = env.get("HOME_WALLET_ADDRESS", os.environ.get("HOME_WALLET_ADDRESS", ""))
        if not wallet:
            print("Error: HOME_WALLET_ADDRESS not found in .env or environment")
            sys.exit(1)
        agent_key = sys.argv[2]
    else:
        if len(sys.argv) < 3:
            print("Usage: python verify_payment.py <wallet_address> <agent_key>")
            sys.exit(1)
        wallet = sys.argv[1]
        agent_key = sys.argv[2]

    print(f"Wallet:    {wallet}")
    print(f"Agent key: {agent_key}")
    print(f"RPC:       {SOLANA_RPC}")
    print(f"Min USDC:  {MIN_PAYMENT}")
    print()

    verified, tx_sig = verify_payment(wallet, agent_key)

    if verified:
        print(f"VERIFIED — payment found in tx: {tx_sig}")
    else:
        print("NOT VERIFIED — no matching payment found in recent transactions.")

    sys.exit(0 if verified else 1)


if __name__ == "__main__":
    main()
