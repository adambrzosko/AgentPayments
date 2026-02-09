const crypto = require('node:crypto');

const COOKIE_NAME = '__agp_verified';
const COOKIE_MAX_AGE = 86400;
const KEY_PREFIX = 'ag_';
const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RPC_DEVNET = 'https://api.devnet.solana.com';
const RPC_MAINNET = 'https://api.mainnet-beta.solana.com';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MIN_PAYMENT = 0.01;

function hmacSign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function generateAgentKey(secret) {
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const sig = hmacSign(random, secret);
  return `${KEY_PREFIX}${random}_${sig.slice(0, 16)}`;
}

function isValidAgentKey(key, secret) {
  if (!key || !key.startsWith(KEY_PREFIX)) return false;
  const rest = key.slice(KEY_PREFIX.length);
  const underscoreIndex = rest.indexOf('_');
  if (underscoreIndex === -1) return false;
  const random = rest.slice(0, underscoreIndex);
  const sig = rest.slice(underscoreIndex + 1);
  const expected = hmacSign(random, secret);
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected.slice(0, 16)));
}

async function rpcCall(rpcUrl, method, params) {
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!resp.ok) throw new Error(`RPC ${method} failed: ${resp.status}`);
  return resp.json();
}

async function verifyPaymentOnChain(agentKey, walletAddress, rpcUrl, usdcMint) {
  try {
    const ataData = await rpcCall(rpcUrl, 'getTokenAccountsByOwner', [
      walletAddress,
      { mint: usdcMint },
      { encoding: 'jsonParsed' },
    ]);

    const tokenAccounts = (ataData.result?.value || []).map((a) => a.pubkey);
    const addressesToScan = [walletAddress, ...tokenAccounts];
    const seen = new Set();
    const allSignatures = [];

    for (const addr of addressesToScan) {
      const sigsData = await rpcCall(rpcUrl, 'getSignaturesForAddress', [addr, { limit: 50 }]);
      for (const sig of sigsData.result || []) {
        if (!seen.has(sig.signature)) {
          seen.add(sig.signature);
          allSignatures.push(sig);
        }
      }
    }

    for (const sigInfo of allSignatures) {
      if (sigInfo.err) continue;

      const txData = await rpcCall(rpcUrl, 'getTransaction', [
        sigInfo.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);
      const tx = txData.result;
      if (!tx) continue;

      const instructions = tx.transaction?.message?.instructions || [];
      const innerInstructions = tx.meta?.innerInstructions || [];
      const allInstructions = [...instructions, ...innerInstructions.flatMap((inner) => inner.instructions || [])];

      let hasMemo = false;
      let hasPayment = false;

      for (const ix of allInstructions) {
        if (ix.program === 'spl-memo' || ix.programId === MEMO_PROGRAM) {
          const memo = typeof ix.parsed === 'string' ? ix.parsed : '';
          if (memo.includes(agentKey)) hasMemo = true;
        }

        if (ix.program === 'spl-token') {
          const parsed = ix.parsed || {};
          if (parsed.type === 'transfer' || parsed.type === 'transferChecked') {
            const info = parsed.info || {};
            if (parsed.type === 'transferChecked' && info.mint !== usdcMint) continue;
            const uiAmount = info.tokenAmount?.uiAmount ?? Number.parseFloat(info.amount || '0') / 1e6;
            if (uiAmount >= MIN_PAYMENT) hasPayment = true;
          }
        }
      }

      if (hasMemo && hasPayment) return true;
    }
  } catch (error) {
    console.error('[gate] Solana RPC error:', error);
  }

  return false;
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function isValidCookie(req, secret) {
  const cookie = getCookie(req, COOKIE_NAME);
  if (!cookie) return false;

  const dotIndex = cookie.indexOf('.');
  if (dotIndex === -1) return false;

  const timestamp = cookie.slice(0, dotIndex);
  const signature = cookie.slice(dotIndex + 1);
  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Date.now() - ts > COOKIE_MAX_AGE * 1000) return false;

  const expected = hmacSign(timestamp, secret);
  return signature === expected;
}

function isPublicPath(pathname) {
  if (pathname === '/robots.txt') return true;
  if (pathname.startsWith('/.well-known/')) return true;
  return false;
}

function isBrowser(req) {
  return Boolean(req.headers['sec-fetch-mode'] || req.headers['sec-fetch-dest']);
}

function challengePage(returnTo, nonce) {
  const safePath = returnTo.startsWith('/') ? returnTo : '/';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Just a moment...</title>
</head>
<body>
  <script>
    (function() {
      if (navigator.webdriver) return;
      var c = document.createElement("canvas"); c.width = 200; c.height = 50;
      var ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.font = "18px Arial"; ctx.fillStyle = "#1a1a2e"; ctx.fillText("verify", 10, 30);
      var data = c.toDataURL();
      if (!data || data.length < 100) return;
      if (typeof window.innerWidth === "undefined" || window.innerWidth === 0) return;
      var form = document.createElement("form"); form.method = "POST"; form.action = "/__challenge/verify";
      var fields = { nonce: ${JSON.stringify(nonce)}, return_to: ${JSON.stringify(safePath)}, fp: data.slice(22, 86) };
      for (var key in fields) { var input = document.createElement("input"); input.type = "hidden"; input.name = key; input.value = fields[key]; form.appendChild(input); }
      document.body.appendChild(form); form.submit();
    })();
  </script>
</body>
</html>`;
}

function json(res, status, body) {
  res.status(status).set('Content-Type', 'application/json').send(JSON.stringify(body, null, 2));
}

function agentPaymentsGate(config = {}) {
  const {
    challengeSecret,
    homeWalletAddress,
    solanaRpcUrl,
    usdcMint,
    debug = process.env.DEBUG !== 'false',
  } = config;

  const secret = challengeSecret || 'default-secret-change-me';
  const walletAddress = homeWalletAddress || '';
  const rpcUrl = solanaRpcUrl || (debug ? RPC_DEVNET : RPC_MAINNET);
  const mint = usdcMint || (debug ? USDC_MINT_DEVNET : USDC_MINT_MAINNET);
  const network = debug ? 'devnet' : 'mainnet-beta';

  return async function agentPaymentsGateMiddleware(req, res, next) {
    const pathname = req.path;

    if (isPublicPath(pathname)) return next();

    if (pathname === '/__challenge/verify' && req.method === 'POST') {
      const nonce = req.body?.nonce || req.query?.nonce || '';
      const returnTo = req.body?.return_to || req.query?.return_to || '/';
      const fp = req.body?.fp || req.query?.fp || '';

      const dotIndex = nonce.indexOf('.');
      if (dotIndex === -1 || !fp || fp.length < 10) {
        return json(res, 403, { error: 'forbidden', message: 'Challenge verification failed.' });
      }

      const nonceTs = nonce.slice(0, dotIndex);
      const nonceSig = nonce.slice(dotIndex + 1);
      const ts = Number.parseInt(nonceTs, 10);
      if (Number.isNaN(ts) || Date.now() - ts > 300000) {
        return json(res, 403, { error: 'forbidden', message: 'Challenge expired. Reload the page.' });
      }

      const expectedSig = hmacSign(`nonce:${nonceTs}`, secret);
      if (nonceSig !== expectedSig) {
        return json(res, 403, { error: 'forbidden', message: 'Invalid challenge.' });
      }

      const now = Date.now().toString();
      const cookieSig = hmacSign(now, secret);
      const safePath = returnTo.startsWith('/') ? returnTo : '/';

      res.cookie(COOKIE_NAME, `${now}.${cookieSig}`, {
        maxAge: COOKIE_MAX_AGE * 1000,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      });
      return res.redirect(302, safePath);
    }

    if (!isBrowser(req)) {
      const agentKey = req.get('X-Agent-Key');

      if (!agentKey) {
        const newKey = generateAgentKey(secret);
        return json(res, 402, {
          error: 'payment_required',
          message: 'Access requires a paid API key. A key has been generated for you below. Send a USDC payment on Solana with this key as the memo to activate it, then retry your request with the X-Agent-Key header.',
          your_key: newKey,
          payment: {
            chain: 'solana',
            network,
            token: 'USDC',
            amount: String(MIN_PAYMENT),
            wallet_address: walletAddress,
            memo: newKey,
            instructions: `Send ${MIN_PAYMENT} USDC on Solana ${debug ? 'devnet' : 'mainnet'} to ${walletAddress} with memo "${newKey}". Then include the header X-Agent-Key: ${newKey} on all subsequent requests.`,
          },
        });
      }

      if (!isValidAgentKey(agentKey, secret)) {
        return json(res, 403, {
          error: 'forbidden',
          message: 'Invalid API key. Keys must be issued by this server.',
          details: 'GET /.well-known/agent-access.json for access instructions.',
        });
      }

      if (!walletAddress) {
        return json(res, 500, { error: 'server_error', message: 'Payment verification unavailable.' });
      }

      const paid = await verifyPaymentOnChain(agentKey, walletAddress, rpcUrl, mint);
      if (!paid) {
        return json(res, 402, {
          error: 'payment_required',
          message: 'Key is valid but payment has not been verified on-chain yet. Please send the USDC payment and allow a few moments for confirmation.',
          your_key: agentKey,
          payment: {
            chain: 'solana',
            network,
            token: 'USDC',
            amount: String(MIN_PAYMENT),
            wallet_address: walletAddress,
            memo: agentKey,
          },
        });
      }

      return next();
    }

    if (isValidCookie(req, secret)) return next();

    const nonceTs = Date.now().toString();
    const nonceSig = hmacSign(`nonce:${nonceTs}`, secret);
    return res.status(200).set('Cache-Control', 'no-store').set('Content-Type', 'text/html').send(challengePage(req.originalUrl || req.url, `${nonceTs}.${nonceSig}`));
  };
}

module.exports = { agentPaymentsGate };
