#!/usr/bin/env python3
"""
Bot visitor for the local demo page.

Opens a local HTML file in headless Chromium, reads the wallet address and
reference ID, funds a persistent devnet wallet if needed, sends a SOL transfer
with the memo, and waits for the page to grant access.
"""

import argparse
import json
import time
from pathlib import Path

import base58
from playwright.async_api import async_playwright
from solana.rpc.api import Client
from solders.instruction import Instruction
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer
from solders.transaction import Transaction

DEVNET_RPC = "https://api.devnet.solana.com"
MEMO_PROGRAM_ID = Pubkey.from_string("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
BOT_WALLET_FILE = Path(__file__).resolve().parent / "bot-wallet.json"
DEFAULT_HTML = Path(__file__).resolve().parent.parent / "python_implementation/django" / "static" / "index.html"


async def launch_and_parse_page(playwright, target_url: str):
    print("[1/5] Launching headless browser...")
    browser = await playwright.chromium.launch(
        headless=True,
        args=["--disable-web-security", "--allow-file-access-from-files"],
    )
    page = await browser.new_page()

    def on_console(msg):
        if msg.type == "error":
            print(f"  [browser error] {msg.text}")

    page.on("console", on_console)

    await page.goto(target_url, wait_until="networkidle")

    await page.wait_for_selector("#payment-wall")
    await page.wait_for_function(
        "document.getElementById('ref-id') && document.getElementById('ref-id').textContent.trim().length > 0"
    )

    wallet_address = await page.eval_on_selector(
        "#payment-wall p:nth-of-type(2) code",
        "el => el.textContent.trim()",
    )
    ref_id = await page.eval_on_selector("#ref-id", "el => el.textContent.trim()")

    print("  Parsed wallet address:", wallet_address)
    print("  Parsed reference ID:", ref_id)

    return browser, page, wallet_address, ref_id


def load_or_create_bot_wallet():
    print("\n[2/5] Loading bot wallet...")

    if BOT_WALLET_FILE.exists():
        data = json.loads(BOT_WALLET_FILE.read_text())
        secret = base58.b58decode(data["secretKey"])
        keypair = Keypair.from_bytes(secret)
        print("  Loaded existing wallet:", keypair.pubkey())
        return keypair

    keypair = Keypair()
    data = {
        "publicKey": str(keypair.pubkey()),
        "secretKey": base58.b58encode(bytes(keypair)).decode("utf-8"),
    }
    BOT_WALLET_FILE.write_text(json.dumps(data, indent=2) + "\n")
    print("  Created new wallet:", keypair.pubkey())
    print("  Saved to:", BOT_WALLET_FILE)
    return keypair


def wait_for_confirmation(client: Client, signature: str, label: str, max_wait: int = 30) -> bool:
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


def fund_with_sol(client: Client, keypair: Keypair):
    print("\n[3/5] Checking SOL balance...")

    balance = client.get_balance(keypair.pubkey()).value
    balance_sol = balance / 1e9
    print("  Current balance:", f"{balance_sol:.4f} SOL")

    if balance_sol >= 0.1:
        print("  Sufficient balance, skipping airdrop.")
        return

    print("  Requesting SOL airdrop on devnet...")
    amounts = [1_000_000_000, 500_000_000]
    max_retries = 3

    for amount in amounts:
        for attempt in range(1, max_retries + 1):
            try:
                print(f"  Attempting {amount / 1e9} SOL airdrop (attempt {attempt})...")
                airdrop_sig = client.request_airdrop(keypair.pubkey(), amount).value
                wait_for_confirmation(client, airdrop_sig, "airdrop")
                new_balance = client.get_balance(keypair.pubkey()).value
                print("  Airdrop confirmed. Balance:", f"{new_balance / 1e9:.4f} SOL")
                return
            except Exception as exc:
                print(f"  Airdrop failed: {exc}")
                if attempt < max_retries:
                    wait = attempt * 5
                    print(f"  Retrying in {wait}s...")
                    time.sleep(wait)

    raise RuntimeError("Could not airdrop SOL. Devnet faucet may be rate-limited — try again later.")


def send_payment(client: Client, bot_keypair: Keypair, recipient_address: str, ref_id: str):
    print("\n[4/5] Sending payment with memo...")
    recipient_pubkey = Pubkey.from_string(recipient_address)
    lamports = 1_000_000  # 0.001 SOL

    print("  From:", bot_keypair.pubkey())
    print("  To:", recipient_address)
    print("  Amount: 0.001 SOL")
    print("  Memo:", ref_id)

    memo_ix = Instruction(program_id=MEMO_PROGRAM_ID, accounts=[], data=ref_id.encode("utf-8"))
    transfer_ix = transfer(
        TransferParams(
            from_pubkey=bot_keypair.pubkey(),
            to_pubkey=recipient_pubkey,
            lamports=lamports,
        )
    )

    blockhash = client.get_latest_blockhash().value.blockhash
    tx = Transaction.new_signed_with_payer(
        [memo_ix, transfer_ix],
        bot_keypair.pubkey(),
        [bot_keypair],
        blockhash,
    )

    result = client.send_transaction(tx)
    tx_sig = result.value
    print("\n  Transaction successful!")
    print("  Signature:", tx_sig)
    print("  Explorer:", f"https://explorer.solana.com/tx/{tx_sig}?cluster=devnet")
    wait_for_confirmation(client, tx_sig, "payment")
    return tx_sig


async def wait_for_access(page) -> bool:
    print("\n[5/5] Waiting for page to verify payment and grant access...")
    timeout = 120
    poll_interval = 2
    start = time.time()

    while time.time() - start < timeout:
        granted = await page.evaluate(
            "(() => { const gated = document.getElementById('gated-content'); "
            "return gated && gated.style.display === 'block'; })()"
        )
        if granted:
            print("  Access granted! Gated content is now visible.")
            return True
        await page.wait_for_timeout(poll_interval * 1000)

    print("  Timed out waiting for access.")
    return False


async def main():
    parser = argparse.ArgumentParser(description="Bot visitor for the local payment wall demo.")
    parser.add_argument(
        "--file",
        default=str(DEFAULT_HTML),
        help="Path to the local HTML file (default: python_implementation/django/static/index.html).",
    )
    args = parser.parse_args()

    target_url = Path(args.file).resolve().as_uri()
    async with async_playwright() as p:
        browser, page, wallet_address, ref_id = await launch_and_parse_page(p, target_url)
        try:
            bot_keypair = load_or_create_bot_wallet()
            client = Client(DEVNET_RPC)

            fund_with_sol(client, bot_keypair)
            send_payment(client, bot_keypair, wallet_address, ref_id)

            access_granted = await wait_for_access(page)
            if access_granted:
                page_title = await page.eval_on_selector(
                    "#gated-content .hero h2",
                    "el => el.textContent.trim()",
                )
                print(f'\n  Page content title: "{page_title}"')
                print("\nDone. Bot successfully paid and accessed the site.")
            else:
                print("\nDone. Payment was sent but page did not grant access within timeout.")
        finally:
            await browser.close()


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
