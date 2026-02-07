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
from solana.rpc.api import Client
from solana.transaction import Transaction
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

    # 1. Create temp wallet
    payer = Keypair()
    print(f"1. Created temp wallet: {payer.pubkey()}")

    # 2. Airdrop SOL for fees
    print("2. Requesting 2 SOL airdrop...")
    airdrop_sig = client.request_airdrop(payer.pubkey(), 2_000_000_000)
    wait_for_confirmation(client, airdrop_sig.value, "airdrop")

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
    token.mint_to(sender_ata, payer, MINT_AMOUNT)

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

    tx = Transaction(
        fee_payer=payer.pubkey(),
        recent_blockhash=recent_blockhash,
    )
    tx.add(transfer_ix, memo_ix)
    tx.sign(payer)

    result = client.send_transaction(tx, payer)
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
