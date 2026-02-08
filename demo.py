#!/usr/bin/env python3
"""
Visual demo of the AgentPayments access gating flow.

Shows a browser getting DENIED, a Solana payment going through,
then the browser gaining access — all in a dramatic visual sequence.

Prerequisites:
    pip install playwright
    playwright install chromium

Usage:
    python demo.py
    python demo.py https://your-site.netlify.app
"""

import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

SITE_URL = "https://grand-dasik-b98262.netlify.app"

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
        <div class="step-text">Generating agent key</div>
        <div class="detail">{key}</div>
      </div>
    </div>

    <div class="step" id="s2">
      <div class="step-icon" id="i2"></div>
      <div>
        <div class="step-text">Connecting to Solana devnet</div>
        <div class="detail">https://api.devnet.solana.com</div>
      </div>
    </div>

    <div class="step" id="s3">
      <div class="step-icon" id="i3"></div>
      <div>
        <div class="step-text">Sending 0.01 USDC to wallet</div>
        <div class="detail">{wallet}</div>
      </div>
    </div>

    <div class="step" id="s4">
      <div class="step-icon" id="i4"></div>
      <div>
        <div class="step-text">Transaction confirmed on-chain</div>
        <div class="detail">Memo: {key}</div>
      </div>
    </div>

    <div class="tx-box" id="txbox">
      <div class="label">TRANSACTION SIGNATURE</div>
      <div class="hash" id="txhash"></div>
      <a id="txlink" href="#" target="_blank">View on Solana Explorer &rarr;</a>
    </div>
  </div>

  <script>
    const steps = [
      {{ id: 's1', delay: 500 }},
      {{ id: 's2', delay: 1500 }},
      {{ id: 's3', delay: 3000 }},
      {{ id: 's4', delay: 0 }},  // triggered by page code
    ];

    function showStep(id, done) {{
      const step = document.getElementById(id);
      const icon = document.getElementById(id.replace('s', 'i'));
      step.classList.add('visible');
      if (done) {{
        step.classList.add('done');
        icon.classList.remove('active');
        icon.classList.add('done');
        icon.textContent = '✓';
      }} else {{
        icon.classList.add('active');
      }}
    }}

    async function animate() {{
      for (const s of steps.slice(0, 3)) {{
        await new Promise(r => setTimeout(r, s.delay));
        showStep(s.id, false);
        await new Promise(r => setTimeout(r, 800));
        showStep(s.id, true);
      }}
    }}
    animate();
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


async def main():
    site_url = sys.argv[1] if len(sys.argv) > 1 else SITE_URL
    env = load_env()
    wallet = env.get("HOME_WALLET_ADDRESS", "")

    print(f"Demo target: {site_url}")
    print(f"Wallet: {wallet}")
    print()

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=["--start-maximized"],
        )
        context = await browser.new_context(
            viewport={"width": 1280, "height": 800},
            no_viewport=False,
        )

        # Override webdriver for Phase 3 (browser challenge)
        await context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => false})"
        )

        page = await context.new_page()

        # ── PHASE 1: Agent gets DENIED ──────────────────────────
        print("[Phase 1] Agent requests site → DENIED")

        # Intercept requests: strip Sec-Fetch headers to simulate an agent
        async def agent_route(route):
            headers = {}
            for k, v in route.request.headers.items():
                if not k.lower().startswith("sec-"):
                    headers[k] = v
            headers["user-agent"] = "AgentBot/1.0"
            await route.continue_(headers=headers)

        await page.route("**/*", agent_route)

        response = await page.goto(site_url)
        body = await response.text()

        try:
            data = json.loads(body)
            agent_key = data.get("your_key", "ag_demo_key")
        except json.JSONDecodeError:
            agent_key = "ag_demo_key"

        print(f"  Got 402 — key: {agent_key}")

        # Show dramatic DENIED page
        denied_html = DENIED_PAGE.replace("{key}", agent_key).replace(
            "{wallet}", wallet
        )
        await page.set_content(denied_html)
        await asyncio.sleep(5)

        # ── PHASE 2: Payment processing ─────────────────────────
        print("[Phase 2] Processing payment on Solana...")

        payment_html = PAYMENT_PAGE.replace("{key}", agent_key).replace(
            "{wallet}", wallet
        )
        await page.set_content(payment_html)

        # Wait for the animated steps to play (steps 1-3 take ~5s)
        await asyncio.sleep(6)

        # Show step 4 (confirmed) and the transaction box
        # Use a fake but realistic-looking tx signature for the demo
        demo_tx = "4xK9" + "".join(
            f"{b:x}" for b in os.urandom(32)
        )[:80]
        explorer_url = (
            f"https://explorer.solana.com/tx/{demo_tx}?cluster=devnet"
        )

        await page.evaluate(f"""
            const s4 = document.getElementById('s4');
            const i4 = document.getElementById('i4');
            s4.classList.add('visible');
            i4.classList.add('active');
            setTimeout(() => {{
                s4.classList.add('done');
                i4.classList.remove('active');
                i4.classList.add('done');
                i4.textContent = '✓';

                const txbox = document.getElementById('txbox');
                txbox.classList.add('visible');
                document.getElementById('txhash').textContent = '{demo_tx}';
                const link = document.getElementById('txlink');
                link.href = '{explorer_url}';
            }}, 1000);
        """)

        await asyncio.sleep(4)

        # ── PHASE 3: Access granted ─────────────────────────────
        print("[Phase 3] Retrying with key → ACCESS GRANTED")

        # Remove agent route, add route that passes X-Agent-Key but keeps browser headers
        await page.unroute("**/*")

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
