import asyncio
import json
import os
import time

from django.core.management.base import BaseCommand

import base58
import requests
from solders.keypair import Keypair as SoldersKeypair
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer
from solders.transaction import Transaction
from solders.message import Message
from solders.hash import Hash

BOT_WALLET_FILE = "bot-wallet.json"
DEVNET_RPC = "https://api.devnet.solana.com"
LAMPORTS_PER_SOL = 1_000_000_000


def rpc_call(method, params):
    resp = requests.post(
        DEVNET_RPC,
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


class Command(BaseCommand):
    help = "Run a headless bot that pays to access the gated site"

    def add_arguments(self, parser):
        parser.add_argument(
            "--url",
            default="http://localhost:8000",
            help="URL of the running AgentPayments server",
        )

    def handle(self, *args, **options):
        site_url = options["url"].rstrip("/")

        # Step 1: Make initial request to get agent key
        self.stdout.write("\n[1/5] Making initial request to get agent key...")
        resp = requests.get(site_url, timeout=30)

        if resp.status_code != 402:
            self.stderr.write(
                self.style.ERROR(f"  Expected 402, got {resp.status_code}. Is the server running?")
            )
            return

        data = resp.json()
        agent_key = data.get("your_key", "")
        payment_info = data.get("payment", {})
        wallet_address = payment_info.get("wallet_address", "")

        self.stdout.write(f"  Agent key: {agent_key}")
        self.stdout.write(f"  Wallet address: {wallet_address}")

        # Step 2: Load or create bot wallet
        self.stdout.write("\n[2/5] Loading bot wallet...")
        bot_keypair = self._load_or_create_wallet()
        self.stdout.write(f"  Bot wallet: {bot_keypair.pubkey()}")

        # Step 3: Fund with SOL if needed
        self.stdout.write("\n[3/5] Checking SOL balance...")
        balance_data = rpc_call("getBalance", [str(bot_keypair.pubkey())])
        balance = balance_data.get("result", {}).get("value", 0)
        balance_sol = balance / LAMPORTS_PER_SOL
        self.stdout.write(f"  Current balance: {balance_sol} SOL")

        if balance_sol < 0.1:
            self.stdout.write("  Requesting SOL airdrop on devnet...")
            try:
                airdrop_data = rpc_call("requestAirdrop", [
                    str(bot_keypair.pubkey()), int(1 * LAMPORTS_PER_SOL)
                ])
                sig = airdrop_data.get("result", "")
                self.stdout.write(f"  Airdrop signature: {sig}")
                self.stdout.write("  Waiting for confirmation...")
                time.sleep(10)

                balance_data = rpc_call("getBalance", [str(bot_keypair.pubkey())])
                balance = balance_data.get("result", {}).get("value", 0)
                self.stdout.write(f"  New balance: {balance / LAMPORTS_PER_SOL} SOL")
            except Exception as e:
                self.stderr.write(self.style.ERROR(f"  Airdrop failed: {e}"))
                return

        # Step 4: Send SOL payment with memo
        self.stdout.write("\n[4/5] Sending payment with memo...")
        self.stdout.write(f"  From: {bot_keypair.pubkey()}")
        self.stdout.write(f"  To: {wallet_address}")
        self.stdout.write(f"  Memo: {agent_key}")

        try:
            tx_sig = self._send_payment_with_memo(bot_keypair, wallet_address, agent_key)
            self.stdout.write(self.style.SUCCESS(f"  Transaction signature: {tx_sig}"))
            self.stdout.write(f"  Explorer: https://explorer.solana.com/tx/{tx_sig}?cluster=devnet")
        except Exception as e:
            self.stderr.write(self.style.ERROR(f"  Payment failed: {e}"))
            return

        # Step 5: Retry request with agent key
        self.stdout.write("\n[5/5] Retrying request with agent key...")
        self.stdout.write("  Waiting for transaction to confirm...")
        time.sleep(5)

        for attempt in range(1, 13):
            resp = requests.get(
                site_url,
                headers={"X-Agent-Key": agent_key},
                timeout=30,
            )
            if resp.status_code == 200:
                self.stdout.write(self.style.SUCCESS("  Access granted!"))
                self.stdout.write(f"\n  Response (first 500 chars):\n{resp.text[:500]}")
                self.stdout.write("\nDone. Bot successfully paid and accessed the site.")
                return
            self.stdout.write(f"  Attempt {attempt}: status {resp.status_code}, retrying in 5s...")
            time.sleep(5)

        self.stderr.write(self.style.ERROR("\n  Timed out waiting for payment verification."))

    def _load_or_create_wallet(self):
        if os.path.exists(BOT_WALLET_FILE):
            with open(BOT_WALLET_FILE) as f:
                data = json.load(f)
            secret_bytes = base58.b58decode(data["secretKey"])
            return SoldersKeypair.from_bytes(secret_bytes)

        keypair = SoldersKeypair()
        data = {
            "publicKey": str(keypair.pubkey()),
            "secretKey": base58.b58encode(bytes(keypair)).decode(),
        }
        with open(BOT_WALLET_FILE, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        self.stdout.write(f"  Created new wallet: {keypair.pubkey()}")
        self.stdout.write(f"  Saved to: {BOT_WALLET_FILE}")
        return keypair

    def _send_payment_with_memo(self, bot_keypair, recipient_address, memo_text):
        """Send SOL with a memo instruction using raw RPC calls."""
        from solders.instruction import Instruction, AccountMeta

        recipient = Pubkey.from_string(recipient_address)
        memo_program = Pubkey.from_string("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")

        # Build memo instruction
        memo_ix = Instruction(
            program_id=memo_program,
            accounts=[AccountMeta(pubkey=bot_keypair.pubkey(), is_signer=True, is_writable=False)],
            data=memo_text.encode("utf-8"),
        )

        # Build SOL transfer instruction (0.001 SOL)
        transfer_ix = transfer(TransferParams(
            from_pubkey=bot_keypair.pubkey(),
            to_pubkey=recipient,
            lamports=1_000_000,
        ))

        # Get recent blockhash
        bh_data = rpc_call("getLatestBlockhash", [])
        blockhash_str = bh_data["result"]["value"]["blockhash"]
        blockhash = Hash.from_string(blockhash_str)

        # Build and sign transaction
        msg = Message.new_with_blockhash(
            [memo_ix, transfer_ix],
            bot_keypair.pubkey(),
            blockhash,
        )
        tx = Transaction.new_unsigned(msg)
        tx.sign([bot_keypair], blockhash)

        # Send transaction
        tx_bytes = bytes(tx)
        import base64
        tx_b64 = base64.b64encode(tx_bytes).decode()

        send_data = rpc_call("sendTransaction", [
            tx_b64,
            {"encoding": "base64", "skipPreflight": False},
        ])

        if "error" in send_data:
            raise RuntimeError(f"Transaction failed: {send_data['error']}")

        return send_data.get("result", "")
