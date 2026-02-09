const COOKIE_NAME = '__agp_verified';
const COOKIE_MAX_AGE = 86400;
const KEY_PREFIX = 'ag_';
const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RPC_DEVNET = 'https://api.devnet.solana.com';
const RPC_MAINNET = 'https://api.mainnet-beta.solana.com';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MIN_PAYMENT = 0.01;

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function generateAgentKey(secret) {
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const sig = await hmacSign(random, secret);
  return `${KEY_PREFIX}${random}_${sig.slice(0, 16)}`;
}

async function isValidAgentKey(key, secret) {
  if (!key || !key.startsWith(KEY_PREFIX)) {
    return false;
  }
  const rest = key.slice(KEY_PREFIX.length);
  const underscoreIndex = rest.indexOf('_');
  if (underscoreIndex === -1) {
    return false;
  }
  const random = rest.slice(0, underscoreIndex);
  const sig = rest.slice(underscoreIndex + 1);
  const expected = await hmacSign(random, secret);
  return sig === expected.slice(0, 16);
}

async function verifyPaymentOnChain(agentKey, walletAddress, rpcUrl, usdcMint) {
  try {
    const ataResp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [walletAddress, { mint: usdcMint }, { encoding: 'jsonParsed' }],
      }),
    });
    const ataData = await ataResp.json();
    const tokenAccounts = (ataData.result?.value || []).map((entry) => entry.pubkey);

    const addressesToScan = [walletAddress, ...tokenAccounts];
    const seen = new Set();
    const allSignatures = [];

    for (const addr of addressesToScan) {
      const sigsResp = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress',
          params: [addr, { limit: 50 }],
        }),
      });
      const sigsData = await sigsResp.json();
      for (const sig of sigsData.result || []) {
        if (!seen.has(sig.signature)) {
          seen.add(sig.signature);
          allSignatures.push(sig);
        }
      }
    }

    for (const sigInfo of allSignatures) {
      if (sigInfo.err) {
        continue;
      }

      const txResp = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [sigInfo.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        }),
      });
      const txData = await txResp.json();
      const tx = txData.result;
      if (!tx) {
        continue;
      }

      const instructions = tx.transaction?.message?.instructions || [];
      const innerInstructions = tx.meta?.innerInstructions || [];
      const allInstructions = [
        ...instructions,
        ...innerInstructions.flatMap((inner) => inner.instructions || []),
      ];

      let hasMemo = false;
      let hasPayment = false;

      for (const ix of allInstructions) {
        if (ix.program === 'spl-memo' || ix.programId === MEMO_PROGRAM) {
          const memo = typeof ix.parsed === 'string' ? ix.parsed : '';
          if (memo.includes(agentKey)) {
            hasMemo = true;
          }
        }

        if (ix.program === 'spl-token') {
          const parsed = ix.parsed || {};
          if (parsed.type === 'transfer' || parsed.type === 'transferChecked') {
            const info = parsed.info || {};
            if (parsed.type === 'transferChecked' && info.mint !== usdcMint) {
              continue;
            }

            const uiAmount = info.tokenAmount?.uiAmount ?? Number.parseFloat(info.amount || '0') / 1e6;
            if (uiAmount >= MIN_PAYMENT) {
              hasPayment = true;
            }
          }
        }
      }

      if (hasMemo && hasPayment) {
        return true;
      }
    }
  } catch (error) {
    console.error('[gate] Solana RPC error:', error);
  }

  return false;
}

function getCookie(request, name) {
  const cookies = request.headers.get('cookie') || '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function isValidCookie(request, secret) {
  const cookie = getCookie(request, COOKIE_NAME);
  if (!cookie) {
    return false;
  }

  const dotIndex = cookie.indexOf('.');
  if (dotIndex === -1) {
    return false;
  }

  const timestamp = cookie.slice(0, dotIndex);
  const signature = cookie.slice(dotIndex + 1);
  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Date.now() - ts > COOKIE_MAX_AGE * 1000) {
    return false;
  }

  const expected = await hmacSign(timestamp, secret);
  return signature === expected;
}

function isPublicPath(pathname) {
  if (pathname === '/robots.txt') {
    return true;
  }
  if (pathname.startsWith('/.well-known/')) {
    return true;
  }
  return false;
}

function isBrowser(request) {
  const secFetchMode = request.headers.get('sec-fetch-mode');
  const secFetchDest = request.headers.get('sec-fetch-dest');
  return Boolean(secFetchMode || secFetchDest);
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function challengePage(returnTo, nonce) {
  const safePath = returnTo.startsWith('/') ? returnTo : '/';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Just a moment...</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           display: flex; justify-content: center; align-items: center; min-height: 100vh;
           margin: 0; background: #f4f4f8; color: #333; }
    .box { text-align: center; padding: 2rem; }
    .spinner { width: 40px; height: 40px; border: 4px solid #e8e8e8; border-top-color: #1a1a2e;
               border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 1rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
    p { font-size: 1rem; color: #555; }
    .fail { color: #c0392b; }
  </style>
</head>
<body>
  <div class="box">
    <div class="spinner" id="spinner"></div>
    <p id="status">Verifying your browser...</p>
  </div>
  <script>
    (function() {
      var status = document.getElementById("status");
      var spinner = document.getElementById("spinner");
      function fail(msg) { spinner.style.display = "none"; status.className = "fail"; status.textContent = msg; }
      if (navigator.webdriver) return fail("Automated browser detected.");
      var c = document.createElement("canvas"); c.width = 200; c.height = 50;
      var ctx = c.getContext("2d");
      if (!ctx) return fail("Canvas unavailable.");
      ctx.font = "18px Arial"; ctx.fillStyle = "#1a1a2e"; ctx.fillText("verify", 10, 30);
      var data = c.toDataURL();
      if (!data || data.length < 100) return fail("Canvas check failed.");
      if (typeof window.innerWidth === "undefined" || window.innerWidth === 0) return fail("Browser check failed.");
      var form = document.createElement("form"); form.method = "POST"; form.action = "/__challenge/verify";
      var fields = { nonce: ${JSON.stringify(nonce)}, return_to: ${JSON.stringify(safePath)}, fp: data.slice(22, 86) };
      for (var key in fields) { var input = document.createElement("input"); input.type = "hidden"; input.name = key; input.value = fields[key]; form.appendChild(input); }
      document.body.appendChild(form); form.submit();
    })();
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
  });
}

function nextResponse(request, env) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return new Response('ASSETS binding is missing.', { status: 500 });
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const secret = env.CHALLENGE_SECRET || 'default-secret-change-me';
    const walletAddress = env.HOME_WALLET_ADDRESS || '';
    const debug = env.DEBUG !== 'false';
    const rpcUrl = env.SOLANA_RPC_URL || (debug ? RPC_DEVNET : RPC_MAINNET);
    const usdcMint = env.USDC_MINT || (debug ? USDC_MINT_DEVNET : USDC_MINT_MAINNET);

    if (isPublicPath(url.pathname)) {
      return nextResponse(request, env);
    }

    if (url.pathname === '/__challenge/verify' && request.method === 'POST') {
      const formData = await request.formData();
      const nonce = formData.get('nonce')?.toString() || '';
      const returnTo = formData.get('return_to')?.toString() || '/';
      const fp = formData.get('fp')?.toString() || '';

      const dotIndex = nonce.indexOf('.');
      if (dotIndex === -1 || !fp || fp.length < 10) {
        return jsonResponse({ error: 'forbidden', message: 'Challenge verification failed.' }, 403);
      }

      const nonceTs = nonce.slice(0, dotIndex);
      const nonceSig = nonce.slice(dotIndex + 1);
      const ts = Number.parseInt(nonceTs, 10);

      if (Number.isNaN(ts) || Date.now() - ts > 300000) {
        return jsonResponse({ error: 'forbidden', message: 'Challenge expired. Reload the page.' }, 403);
      }

      const expectedSig = await hmacSign(`nonce:${nonceTs}`, secret);
      if (nonceSig !== expectedSig) {
        return jsonResponse({ error: 'forbidden', message: 'Invalid challenge.' }, 403);
      }

      const now = Date.now().toString();
      const cookieSig = await hmacSign(now, secret);
      const safePath = returnTo.startsWith('/') ? returnTo : '/';

      return new Response(null, {
        status: 302,
        headers: {
          Location: safePath,
          'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(`${now}.${cookieSig}`)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
        },
      });
    }

    if (!isBrowser(request)) {
      const agentKey = request.headers.get('X-Agent-Key');

      if (!agentKey) {
        const newKey = await generateAgentKey(secret);
        return jsonResponse(
          {
            error: 'payment_required',
            message:
              'Access requires a paid API key. A key has been generated for you below. Send a USDC payment on Solana with this key as the memo to activate it, then retry your request with the X-Agent-Key header.',
            your_key: newKey,
            payment: {
              chain: 'solana',
              network: debug ? 'devnet' : 'mainnet-beta',
              token: 'USDC',
              amount: String(MIN_PAYMENT),
              wallet_address: walletAddress,
              memo: newKey,
              instructions:
                `Send ${MIN_PAYMENT} USDC on Solana ${debug ? 'devnet' : 'mainnet'} to ${walletAddress} with memo "${newKey}". Then include the header X-Agent-Key: ${newKey} on all subsequent requests.`,
            },
          },
          402
        );
      }

      if (!(await isValidAgentKey(agentKey, secret))) {
        return jsonResponse(
          {
            error: 'forbidden',
            message: 'Invalid API key. Keys must be issued by this server.',
            details: 'GET /.well-known/agent-access.json for access instructions.',
          },
          403
        );
      }

      if (!walletAddress) {
        console.error('[gate] HOME_WALLET_ADDRESS not set, cannot verify payments');
        return jsonResponse({ error: 'server_error', message: 'Payment verification unavailable.' }, 500);
      }

      const paid = await verifyPaymentOnChain(agentKey, walletAddress, rpcUrl, usdcMint);
      if (!paid) {
        return jsonResponse(
          {
            error: 'payment_required',
            message:
              'Key is valid but payment has not been verified on-chain yet. Please send the USDC payment and allow a few moments for confirmation.',
            your_key: agentKey,
            payment: {
              chain: 'solana',
              network: debug ? 'devnet' : 'mainnet-beta',
              token: 'USDC',
              amount: String(MIN_PAYMENT),
              wallet_address: walletAddress,
              memo: agentKey,
            },
          },
          402
        );
      }

      const ua = request.headers.get('user-agent') || 'unknown';
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      console.log(
        `[gate] Payment verified (${debug ? 'devnet' : 'mainnet'}) - agent access granted: key=${agentKey.slice(0, 12)}... ua=${ua} ip=${ip} path=${url.pathname}`
      );
      return nextResponse(request, env);
    }

    if (await isValidCookie(request, secret)) {
      return nextResponse(request, env);
    }

    const nonceTs = Date.now().toString();
    const nonceSig = await hmacSign(`nonce:${nonceTs}`, secret);
    return challengePage(url.pathname + url.search, `${nonceTs}.${nonceSig}`);
  },
};
