#!/usr/bin/env python3
"""
End-to-end test for the agent payment flow on Solana devnet.

Creates a temporary wallet, airdrops SOL, creates a test SPL token
(simulating USDC), sends a payment with an agent key as the memo,
then verifies the payment was detected.

Usage:
    pip install solana
    python test_payment.py                  # auto-generates a test agent key
    python test_payment.py <agent_key>      # use a specific key (e.g. from a 402 response)

Reads HOME_WALLET_ADDRESS from .env
"""

import os
import sys
import time

from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.instruction import Instruction
from solders.transaction import Transaction
from solders.message import Message
from solana.rpc.api import Client
from spl.token.client import Token
from spl.token.constants import TOKEN_PROGRAM_ID
from spl.token.instructions import transfer_checked, TransferCheckedParams

DEVNET_URL = "https://api.devnet.solana.com"
MEMO_PROGRAM_ID = Pubkey.from_string("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
DECIMALS = 6
TRANSFER_AMOUNT = 10_000  # 0.01 with 6 decimals
MINT_AMOUNT = 1_000_000   # 1.0 with 6 decimals


def load_env(path=".env"):
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


def wait_for_confirmation(client, signature, label="transaction", max_wait=30):
    """Poll until a transaction is confirmed."""
    print(f"   Waiting for {label} confirmation...", end="", flush=True)
    for _ in range(max_wait):
        resp = client.get_signature_statuses([signature])
        statuses = resp.value
        if statuses and statuses[0] and statuses[0].confirmation_status:
            status = str(statuses[0].confirmation_status)
            if status in ("confirmed", "finalized"):
                print(f" {status}")
                return True
        time.sleep(1)
        print(".", end="", flush=True)
    print(" timeout")
    return False


def main():
    env = load_env()
    receiver_addr = env.get("HOME_WALLET_ADDRESS") or os.environ.get("HOME_WALLET_ADDRESS")
    if not receiver_addr:
        print("Error: HOME_WALLET_ADDRESS not found in .env or environment")
        sys.exit(1)

    agent_key = sys.argv[1] if len(sys.argv) > 1 else f"ag_test_{int(time.time())}"
    receiver = Pubkey.from_string(receiver_addr)
    client = Client(DEVNET_URL)

    print("=" * 60)
    print("SOLANA DEVNET PAYMENT TEST")
    print("=" * 60)
    print(f"  Receiver wallet: {receiver_addr}")
    print(f"  Agent key (memo): {agent_key}")
    print(f"  Amount: {TRANSFER_AMOUNT / 10**DECIMALS} tokens")
    print()

    # 1. Load or create payer wallet (persisted so you can manually fund it)
    keyfile = os.path.join(os.path.dirname(__file__) or ".", ".test-keypair.json")
    if os.path.exists(keyfile):
        import json as _json
        with open(keyfile) as f:
            secret = bytes(_json.load(f))
        payer = Keypair.from_bytes(secret)
        print(f"1. Loaded existing wallet: {payer.pubkey()}")
    else:
        payer = Keypair()
        import json as _json
        with open(keyfile, "w") as f:
            _json.dump(list(bytes(payer)), f)
        print(f"1. Created new wallet (saved to {keyfile}): {payer.pubkey()}")

    # 2. Ensure wallet has SOL for fees
    balance = client.get_balance(payer.pubkey()).value
    print(f"2. Current balance: {balance / 1e9} SOL")

    if balance >= 100_000_000:  # 0.1 SOL is plenty for fees
        print("   Balance sufficient, skipping airdrop.")
    else:
        print("   Requesting SOL airdrop...")
        airdrop_sig = None

        for attempt in range(3):
            try:
                resp = client.request_airdrop(payer.pubkey(), 1_000_000_000)
                airdrop_sig = resp.value
                print(f"   RPC airdrop submitted: {airdrop_sig}")
                break
            except Exception as e:
                print(f"   RPC airdrop attempt {attempt + 1} failed: {e}")
                time.sleep(3)

        if airdrop_sig is None:
            print()
            print("   ERROR: Could not airdrop SOL. The devnet faucet is rate-limited.")
            print("   Please manually fund this wallet from https://faucet.solana.com:")
            print(f"   >>> {payer.pubkey()} <<<")
            print("   Then re-run this script.")
            sys.exit(1)

        wait_for_confirmation(client, airdrop_sig, "airdrop")
        balance = client.get_balance(payer.pubkey()).value
        print(f"   Balance: {balance / 1e9} SOL")

    # 3. Create test SPL token (simulating USDC)
    print("3. Creating test SPL token...")
    token = Token.create_mint(
        conn=client,
        payer=payer,
        mint_authority=payer.pubkey(),
        decimals=DECIMALS,
        program_id=TOKEN_PROGRAM_ID,
    )
    mint_address = str(token.pubkey)
    print(f"   Mint address: {mint_address}")

    # 4. Create associated token accounts
    print("4. Creating token accounts...")
    sender_ata = token.create_associated_token_account(payer.pubkey())
    print(f"   Sender ATA:   {sender_ata}")
    receiver_ata = token.create_associated_token_account(receiver)
    print(f"   Receiver ATA: {receiver_ata}")

    # 5. Mint tokens to sender
    print(f"5. Minting {MINT_AMOUNT / 10**DECIMALS} tokens to sender...")
    mint_resp = token.mint_to(sender_ata, payer, MINT_AMOUNT)
    wait_for_confirmation(client, mint_resp.value, "mint")

    # Verify balance before transfer
    token_balance = client.get_token_account_balance(sender_ata)
    print(f"   Token balance: {token_balance.value.ui_amount}")

    # 6. Transfer with memo
    print(f"6. Sending {TRANSFER_AMOUNT / 10**DECIMALS} tokens with memo...")

    transfer_ix = transfer_checked(TransferCheckedParams(
        program_id=TOKEN_PROGRAM_ID,
        source=sender_ata,
        mint=token.pubkey,
        dest=receiver_ata,
        owner=payer.pubkey(),
        amount=TRANSFER_AMOUNT,
        decimals=DECIMALS,
    ))

    memo_ix = Instruction(
        program_id=MEMO_PROGRAM_ID,
        accounts=[],
        data=agent_key.encode("utf-8"),
    )

    blockhash_resp = client.get_latest_blockhash()
    recent_blockhash = blockhash_resp.value.blockhash

    tx = Transaction.new_signed_with_payer(
        [transfer_ix, memo_ix],
        payer.pubkey(),
        [payer],
        recent_blockhash,
    )

    result = client.send_transaction(tx)
    tx_sig = result.value
    print(f"   Transaction: {tx_sig}")
    wait_for_confirmation(client, tx_sig, "transfer")

    # 7. Verify using verify_payment.py logic
    print()
    print("7. Verifying payment on-chain...")
    os.environ["SOLANA_RPC_URL"] = DEVNET_URL
    os.environ["USDC_MINT"] = mint_address

    from verify_payment import verify_payment
    verified, found_sig = verify_payment(receiver_addr, agent_key)

    print()
    print("=" * 60)
    if verified:
        print("SUCCESS — payment verified on devnet!")
    else:
        print("FAILED — payment not detected (may need more confirmations)")
    print("=" * 60)
    print()
    print("Next steps:")
    print(f"  1. Set this Netlify env var:  USDC_MINT = {mint_address}")
    print(f"  2. Test the gate:")
    print(f'     curl -H "X-Agent-Key: {agent_key}" <your-site-url>')
    print()
    print(f"  Or to run verify_payment.py standalone:")
    print(f"     USDC_MINT={mint_address} python verify_payment.py --env {agent_key}")
    print("=" * 60)

    sys.exit(0 if verified else 1)


if __name__ == "__main__":
    main()
