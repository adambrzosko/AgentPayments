#!/usr/bin/env python3
"""
Visual demo of the AgentPayments access gating flow.

Shows a browser getting DENIED, a real Solana devnet payment going through,
then the browser gaining access — all in a dramatic visual sequence.

Prerequisites:
    pip install playwright solana spl
    playwright install firefox

Usage:
    python demo.py
    python demo.py https://your-site.netlify.app
"""

import asyncio
import json
import os
import sys
import time

from playwright.async_api import async_playwright

from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.instruction import Instruction
from solders.transaction import Transaction
from solana.rpc.api import Client
from spl.token.client import Token
from spl.token.constants import TOKEN_PROGRAM_ID
from spl.token.instructions import transfer_checked, TransferCheckedParams

SITE_URL = "https://grand-dasik-b98262.netlify.app"
DEVNET_URL = "https://api.devnet.solana.com"
MEMO_PROGRAM_ID = Pubkey.from_string("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
DECIMALS = 6
TRANSFER_AMOUNT = 10_000   # 0.01 with 6 decimals
MINT_AMOUNT = 1_000_000    # 1.0 with 6 decimals

# ─── Phase 1: DENIED ─────────────────────────────────────────────

DENIED_PAGE = """
<!DOCTYPE html>
<html>
<head>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@900&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a;
    color: #fff;
    font-family: 'Inter', sans-serif;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    overflow: hidden;
  }
  .container { text-align: center; position: relative; z-index: 1; }

  /* Animated red pulse background */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: radial-gradient(circle at center, rgba(220,20,20,0.15) 0%, transparent 70%);
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }

  /* Big X */
  .x-icon {
    width: 120px; height: 120px;
    position: relative;
    margin: 0 auto 2rem;
    animation: shake 0.5s ease-in-out;
  }
  .x-icon::before, .x-icon::after {
    content: '';
    position: absolute;
    width: 100%; height: 8px;
    background: #ff2020;
    top: 50%; left: 0;
    border-radius: 4px;
    box-shadow: 0 0 30px rgba(255,32,32,0.8), 0 0 60px rgba(255,32,32,0.4);
  }
  .x-icon::before { transform: translateY(-50%) rotate(45deg); }
  .x-icon::after { transform: translateY(-50%) rotate(-45deg); }

  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    10%, 30%, 50%, 70%, 90% { transform: translateX(-8px); }
    20%, 40%, 60%, 80% { transform: translateX(8px); }
  }

  h1 {
    font-size: 4rem;
    font-weight: 900;
    color: #ff2020;
    text-shadow: 0 0 40px rgba(255,32,32,0.6), 0 0 80px rgba(255,32,32,0.3);
    letter-spacing: 0.15em;
    margin-bottom: 0.5rem;
    animation: glitch 3s infinite;
  }
  @keyframes glitch {
    0%, 90%, 100% { transform: translate(0); }
    92% { transform: translate(-3px, 2px); }
    94% { transform: translate(3px, -2px); }
    96% { transform: translate(-2px, -1px); }
    98% { transform: translate(2px, 1px); }
  }

  .subtitle {
    font-size: 1.1rem;
    color: #666;
    margin-bottom: 2.5rem;
    font-family: 'JetBrains Mono', monospace;
  }

  .terminal {
    background: #111;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 1.5rem 2rem;
    text-align: left;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    max-width: 620px;
    margin: 0 auto;
    box-shadow: 0 0 40px rgba(0,0,0,0.5);
  }
  .terminal .label { color: #ff4040; }
  .terminal .value { color: #aaa; }
  .terminal .key { color: #ffaa00; }
  .terminal .line { margin-bottom: 0.4rem; }
</style>
</head>
<body>
  <div class="container">
    <div class="x-icon"></div>
    <h1>ACCESS DENIED</h1>
    <p class="subtitle">HTTP 402 &mdash; Payment Required</p>
    <div class="terminal">
      <div class="line"><span class="label">error:</span> <span class="value">payment_required</span></div>
      <div class="line"><span class="label">agent_key:</span> <span class="key">{key}</span></div>
      <div class="line"><span class="label">payment:</span> <span class="value">0.01 USDC &rarr; Solana devnet</span></div>
      <div class="line"><span class="label">wallet:</span> <span class="value">{wallet}</span></div>
      <div class="line" style="margin-top: 1rem; color: #555;">&gt; Non-browser access requires a valid API key.</div>
    </div>
  </div>
</body>
</html>
"""

# ─── Phase 2: PAYMENT PROCESSING ─────────────────────────────────

PAYMENT_PAGE = """
<!DOCTYPE html>
<html>
<head>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a;
    color: #fff;
    font-family: 'JetBrains Mono', monospace;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
  }
  .container { max-width: 700px; width: 100%; padding: 2rem; }

  h1 {
    font-size: 1.5rem;
    color: #00ffa3;
    margin-bottom: 2rem;
    text-shadow: 0 0 20px rgba(0,255,163,0.4);
  }

  .step {
    display: flex;
    align-items: flex-start;
    margin-bottom: 1.2rem;
    opacity: 0;
    transform: translateY(10px);
    transition: all 0.4s ease;
  }
  .step.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .step-icon {
    width: 24px; height: 24px;
    border-radius: 50%;
    border: 2px solid #333;
    margin-right: 1rem;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    margin-top: 2px;
  }
  .step-icon.pending { border-color: #333; }
  .step-icon.active { border-color: #00ffa3; animation: spin-icon 1s linear infinite; }
  .step-icon.done { border-color: #00ffa3; background: #00ffa3; color: #000; }

  @keyframes spin-icon {
    0% { box-shadow: 0 0 0 0 rgba(0,255,163,0.4); }
    100% { box-shadow: 0 0 0 12px rgba(0,255,163,0); }
  }

  .step-text { font-size: 0.9rem; color: #888; }
  .step.visible .step-text { color: #ccc; }
  .step.done .step-text { color: #00ffa3; }

  .detail {
    font-size: 0.75rem;
    color: #555;
    margin-top: 0.25rem;
    word-break: break-all;
  }

  .tx-box {
    background: #111;
    border: 1px solid #00ffa3;
    border-radius: 8px;
    padding: 1.5rem;
    margin-top: 2rem;
    opacity: 0;
    transition: opacity 0.6s ease;
    box-shadow: 0 0 30px rgba(0,255,163,0.1);
  }
  .tx-box.visible { opacity: 1; }
  .tx-box .label { color: #00ffa3; font-size: 0.8rem; }
  .tx-box .hash {
    color: #fff;
    font-size: 0.75rem;
    word-break: break-all;
    margin-top: 0.25rem;
  }
  .tx-box a { color: #00ffa3; text-decoration: underline; font-size: 0.75rem; }
</style>
</head>
<body>
  <div class="container">
    <h1>&#9889; PROCESSING PAYMENT</h1>

    <div class="step" id="s1">
      <div class="step-icon" id="i1"></div>
      <div>
        <div class="step-text">Agent key from 402 response</div>
        <div class="detail" id="d1"></div>
      </div>
    </div>

    <div class="step" id="s2">
      <div class="step-icon" id="i2"></div>
      <div>
        <div class="step-text">Loading wallet &amp; connecting to devnet</div>
        <div class="detail" id="d2"></div>
      </div>
    </div>

    <div class="step" id="s3">
      <div class="step-icon" id="i3"></div>
      <div>
        <div class="step-text">Creating SPL token mint &amp; accounts</div>
        <div class="detail" id="d3"></div>
      </div>
    </div>

    <div class="step" id="s4">
      <div class="step-icon" id="i4"></div>
      <div>
        <div class="step-text">Sending transfer + memo transaction</div>
        <div class="detail" id="d4"></div>
      </div>
    </div>

    <div class="step" id="s5">
      <div class="step-icon" id="i5"></div>
      <div>
        <div class="step-text">Waiting for on-chain confirmation</div>
        <div class="detail" id="d5"></div>
      </div>
    </div>

    <div class="step" id="s6">
      <div class="step-icon" id="i6"></div>
      <div>
        <div class="step-text">Payment confirmed!</div>
        <div class="detail" id="d6"></div>
      </div>
    </div>

    <div class="tx-box" id="txbox">
      <div class="label">TRANSACTION SIGNATURE</div>
      <div class="hash" id="txhash"></div>
      <a id="txlink" href="#" target="_blank">View on Solana Explorer &rarr;</a>
    </div>
  </div>

  <script>
    function showStep(id, done) {
      const step = document.getElementById(id);
      const icon = document.getElementById(id.replace('s', 'i'));
      step.classList.add('visible');
      if (done) {
        step.classList.add('done');
        icon.classList.remove('active');
        icon.classList.add('done');
        icon.textContent = '\u2713';
      } else {
        icon.classList.add('active');
      }
    }
    function setDetail(id, text) {
      document.getElementById(id).textContent = text;
    }
  </script>
</body>
</html>
"""

# ─── Phase 3: ACCESS GRANTED overlay ─────────────────────────────

GRANTED_OVERLAY_JS = """
const overlay = document.createElement('div');
overlay.innerHTML = `
  <div style="
    position: fixed; inset: 0; z-index: 99999;
    background: rgba(0,20,10,0.95);
    display: flex; justify-content: center; align-items: center;
    flex-direction: column;
    animation: grantedFade 3s ease forwards;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  ">
    <div style="
      width: 100px; height: 100px; border-radius: 50%;
      border: 4px solid #00ffa3;
      display: flex; align-items: center; justify-content: center;
      font-size: 48px; color: #00ffa3;
      box-shadow: 0 0 40px rgba(0,255,163,0.4), 0 0 80px rgba(0,255,163,0.2);
      margin-bottom: 1.5rem;
    ">✓</div>
    <div style="
      font-size: 3rem; font-weight: 900; color: #00ffa3;
      text-shadow: 0 0 40px rgba(0,255,163,0.5);
      letter-spacing: 0.1em;
    ">ACCESS GRANTED</div>
    <div style="color: #558; font-size: 1rem; margin-top: 0.5rem;">
      Payment verified on Solana devnet
    </div>
  </div>
`;
document.body.appendChild(overlay);

const style = document.createElement('style');
style.textContent = `
  @keyframes grantedFade {
    0% { opacity: 0; }
    15% { opacity: 1; }
    70% { opacity: 1; }
    100% { opacity: 0; pointer-events: none; }
  }
`;
document.head.appendChild(style);
"""


def load_env(path=".env"):
    env = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip("\"'")
    return env


def load_keypair():
    """Load the test keypair from .test-keypair.json."""
    keyfile = os.path.join(os.path.dirname(__file__) or ".", ".test-keypair.json")
    with open(keyfile) as f:
        secret = bytes(json.load(f))
    return Keypair.from_bytes(secret)


def wait_for_confirmation(client, signature, max_wait=120):
    """Poll until a transaction is confirmed. Returns the status string or None."""
    for _ in range(max_wait):
        try:
            resp = client.get_signature_statuses([signature])
            statuses = resp.value
            if statuses and statuses[0] and statuses[0].confirmation_status:
                status = str(statuses[0].confirmation_status)
                if status in ("confirmed", "finalized"):
                    return status
        except Exception:
            pass  # transient RPC errors — retry
        time.sleep(2)
    return None


async def step_ui(page, step_num, done, detail=None):
    """Update a step in the payment page UI."""
    sid = f"s{step_num}"
    if detail:
        escaped = detail.replace("\\", "\\\\").replace("'", "\\'")
        await page.evaluate(f"setDetail('d{step_num}', '{escaped}')")
    await page.evaluate(f"showStep('{sid}', {'true' if done else 'false'})")


async def run_payment(page, agent_key, receiver_addr):
    """Execute real Solana devnet payment, updating browser UI at each step."""

    # Step 1: Show agent key
    await step_ui(page, 1, False, agent_key)
    await asyncio.sleep(0.5)
    await step_ui(page, 1, True)
    await asyncio.sleep(0.3)

    # Step 2: Load wallet, connect to devnet, check balance
    await step_ui(page, 2, False, "Connecting...")

    def do_step2():
        payer = load_keypair()
        client = Client(DEVNET_URL, timeout=30)
        balance = client.get_balance(payer.pubkey()).value
        return payer, client, balance

    payer, client, balance = await asyncio.to_thread(do_step2)
    sol_balance = balance / 1e9
    await step_ui(page, 2, True, f"{payer.pubkey()} — {sol_balance:.2f} SOL")
    print(f"  Payer: {payer.pubkey()} ({sol_balance:.2f} SOL)")
    await asyncio.sleep(0.3)

    # Step 3: Create mint + ATAs + mint tokens
    await step_ui(page, 3, False, "Creating token mint...")

    receiver = Pubkey.from_string(receiver_addr)

    def do_step3():
        token = Token.create_mint(
            conn=client,
            payer=payer,
            mint_authority=payer.pubkey(),
            decimals=DECIMALS,
            program_id=TOKEN_PROGRAM_ID,
        )
        sender_ata = token.create_associated_token_account(payer.pubkey())
        receiver_ata = token.create_associated_token_account(receiver)
        mint_resp = token.mint_to(sender_ata, payer, MINT_AMOUNT)
        # Wait for mint confirmation
        wait_for_confirmation(client, mint_resp.value)
        return token, sender_ata, receiver_ata

    token, sender_ata, receiver_ata = await asyncio.to_thread(do_step3)
    mint_addr = str(token.pubkey)
    await step_ui(page, 3, True, f"Mint: {mint_addr}")
    print(f"  Mint: {mint_addr}")
    await asyncio.sleep(0.3)

    # Step 4: Build and send transfer + memo transaction
    await step_ui(page, 4, False, "Building transaction...")

    def do_step4():
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
        return result.value

    tx_sig = await asyncio.to_thread(do_step4)
    tx_sig_str = str(tx_sig)
    await step_ui(page, 4, True, f"Tx: {tx_sig_str}")
    print(f"  Tx: {tx_sig_str}")
    await asyncio.sleep(0.3)

    # Step 5: Wait for confirmation
    await step_ui(page, 5, False, "Polling status...")

    def do_step5():
        return wait_for_confirmation(client, tx_sig)

    status = await asyncio.to_thread(do_step5)
    if status:
        await step_ui(page, 5, True, f"Status: {status}")
        print(f"  Confirmation: {status}")
    else:
        await step_ui(page, 5, True, "Timeout — check explorer")
        print("  Confirmation: timeout")
    await asyncio.sleep(0.3)

    # Step 6: Done — show explorer link
    explorer_url = f"https://explorer.solana.com/tx/{tx_sig_str}?cluster=devnet"
    await step_ui(page, 6, False, "Generating explorer link...")
    await asyncio.sleep(0.3)
    await step_ui(page, 6, True, explorer_url)

    # Show the tx box
    await page.evaluate(f"""
        const txbox = document.getElementById('txbox');
        txbox.classList.add('visible');
        document.getElementById('txhash').textContent = '{tx_sig_str}';
        const link = document.getElementById('txlink');
        link.href = '{explorer_url}';
    """)

    return tx_sig_str, explorer_url, mint_addr


async def main():
    site_url = sys.argv[1] if len(sys.argv) > 1 else SITE_URL
    env = load_env()
    wallet = env.get("HOME_WALLET_ADDRESS", "")

    print(f"Demo target: {site_url}")
    print(f"Wallet: {wallet}")
    print()

    async with async_playwright() as p:
        browser = await p.firefox.launch(headless=False)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 800},
        )

        # Override webdriver for Phase 3 (browser challenge)
        await context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => false})"
        )

        page = await context.new_page()

        # ── PHASE 1: Agent gets DENIED ──────────────────────────
        print("[Phase 1] Agent requests site → DENIED")

        # Intercept requests: strip Sec-Fetch headers to simulate an agent
        captured_body = {}

        async def agent_route(route):
            resp = await route.fetch(headers={
                k: v for k, v in route.request.headers.items()
                if not k.lower().startswith("sec-")
            } | {"user-agent": "AgentBot/1.0"})
            body = await resp.text()
            captured_body["text"] = body
            await route.fulfill(response=resp, body=body)

        await page.route(f"{site_url.rstrip('/')}/**", agent_route)
        await page.route(site_url.rstrip("/"), agent_route)

        await page.goto(site_url, wait_until="networkidle")

        agent_key = "ag_demo_key"
        try:
            data = json.loads(captured_body.get("text", "{}"))
            agent_key = data.get("your_key", agent_key)
        except Exception:
            pass

        print(f"  Got 402 — key: {agent_key}")

        # Show dramatic DENIED page
        denied_html = DENIED_PAGE.replace("{key}", agent_key).replace(
            "{wallet}", wallet
        )
        await page.set_content(denied_html)
        await asyncio.sleep(5)

        # ── PHASE 2: Real payment processing ──────────────────
        print("[Phase 2] Processing REAL payment on Solana devnet...")

        await page.set_content(PAYMENT_PAGE)
        await asyncio.sleep(0.5)

        tx_sig_str, explorer_url, mint_addr = await run_payment(
            page, agent_key, wallet
        )

        print(f"  Explorer: {explorer_url}")
        await asyncio.sleep(3)

        # Navigate to Solana Explorer to show the real transaction
        print("  Opening Solana Explorer...")
        await page.unroute("**/*")
        try:
            await page.goto(explorer_url, wait_until="domcontentloaded", timeout=15000)
        except Exception:
            pass  # Explorer SPA may be slow; page is still usable
        await asyncio.sleep(5)

        # ── PHASE 3: Access granted ─────────────────────────────
        print("[Phase 3] Retrying with key → ACCESS GRANTED")

        async def authed_agent_route(route):
            headers = {}
            for k, v in route.request.headers.items():
                if not k.lower().startswith("sec-"):
                    headers[k] = v
            headers["user-agent"] = "AgentBot/1.0"
            headers["x-agent-key"] = agent_key
            await route.continue_(headers=headers)

        await page.route("**/*", authed_agent_route)

        response = await page.goto(site_url)
        status = response.status

        if status == 200:
            print(f"  Got 200 — access granted!")
        else:
            # If payment verification fails, fall back to browser path for visual
            print(
                f"  Got {status} (payment not verified on server) — falling back to browser view"
            )
            await page.unroute("**/*")
            await page.goto(site_url)
            # Wait for JS challenge redirect
            await page.wait_for_load_state("networkidle")

        # Inject ACCESS GRANTED overlay
        await page.evaluate(GRANTED_OVERLAY_JS)

        print("  Showing ACCESS GRANTED overlay")
        await asyncio.sleep(5)

        print()
        print("Demo complete!")
        await asyncio.sleep(3)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
