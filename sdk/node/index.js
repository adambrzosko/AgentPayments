const crypto = require('node:crypto');
const {
  COOKIE_NAME, COOKIE_MAX_AGE, KEY_PREFIX,
  USDC_MINT_DEVNET, USDC_MINT_MAINNET,
  RPC_DEVNET, RPC_MAINNET,
  MEMO_PROGRAM, MIN_PAYMENT,
  MAX_KEY_LENGTH, MAX_NONCE_LENGTH, MAX_RETURN_TO_LENGTH, MAX_FP_LENGTH,
} = require('../constants.json');
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PAYMENT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const PAYMENT_CACHE_MAX = 1000;

class PaymentCache {
  constructor(ttl = PAYMENT_CACHE_TTL, maxSize = PAYMENT_CACHE_MAX) {
    this.ttl = ttl;
    this.maxSize = maxSize;
    this.cache = new Map();
  }
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttl) { this.cache.delete(key); return undefined; }
    return entry.value;
  }
  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { value, ts: Date.now() });
  }
}

function gateLog(level, message, data = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, component: 'agentpayments', message, ...data });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 20; // max requests per window per IP

class RateLimiter {
  constructor(windowMs = RATE_LIMIT_WINDOW, max = RATE_LIMIT_MAX) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }
  check(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.start > this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count++;
    if (entry.count > this.max) return false;
    return true;
  }
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (now - entry.start > this.windowMs) this.hits.delete(key);
    }
  }
}

function hmacSign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function generateAgentKey(secret) {
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const sig = hmacSign(random, secret);
  return `${KEY_PREFIX}${random}_${sig.slice(0, 16)}`;
}

function isValidAgentKey(key, secret) {
  if (!key || key.length > MAX_KEY_LENGTH || !key.startsWith(KEY_PREFIX)) return false;
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

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_P = 2n ** 255n - 19n;
const ED25519_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_PROGRAM_ADDR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function b58decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  while (out.length < 32) out.unshift(0);
  return new Uint8Array(out);
}

function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}

function modpow(b, e, m) {
  let r = 1n; b = ((b % m) + m) % m;
  while (e > 0n) { if (e & 1n) r = r * b % m; e >>= 1n; b = b * b % m; }
  return r;
}

function isOnCurve(bytes) {
  let y = 0n;
  for (let i = 0; i < 32; i++) y += BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]) << BigInt(8 * i);
  if (y >= ED25519_P) return false;
  const y2 = y * y % ED25519_P;
  const x2 = (y2 - 1n + ED25519_P) % ED25519_P * modpow((1n + ED25519_D * y2) % ED25519_P, ED25519_P - 2n, ED25519_P) % ED25519_P;
  if (x2 === 0n) return true;
  return modpow(x2, (ED25519_P - 1n) / 2n, ED25519_P) === 1n;
}

function deriveAta(owner, mint) {
  const seeds = [b58decode(owner), b58decode(TOKEN_PROGRAM_ADDR), b58decode(mint)];
  const programId = b58decode(ASSOCIATED_TOKEN_PROGRAM);
  const suffix = Buffer.from('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const buf = Buffer.concat([...seeds, Buffer.from([bump]), programId, suffix]);
    const hash = crypto.createHash('sha256').update(buf).digest();
    if (!isOnCurve(hash)) return b58encode(hash);
  }
  return null;
}

async function verifyPaymentOnChain(agentKey, walletAddress, rpcUrl, usdcMint) {
  try {
    const derivedAta = deriveAta(walletAddress, usdcMint);

    let rpcAccounts = [];
    try {
      const ataData = await rpcCall(rpcUrl, 'getTokenAccountsByOwner', [
        walletAddress,
        { mint: usdcMint },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ]);
      rpcAccounts = (ataData.result?.value || []).map((a) => a.pubkey);
    } catch (e) {
      gateLog('warn', 'getTokenAccountsByOwner failed, using derived ATA', { error: e.message });
    }

    const addressSet = new Set([walletAddress, ...rpcAccounts]);
    if (derivedAta) addressSet.add(derivedAta);
    const addressesToScan = [...addressSet];
    const seen = new Set();
    const allSignatures = [];

    for (const addr of addressesToScan) {
      const sigsData = await rpcCall(rpcUrl, 'getSignaturesForAddress', [addr, { limit: 50, commitment: 'confirmed' }]);
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
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
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
    gateLog('error', 'Solana RPC error', { error: error.message });
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
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
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
  <title>Verifying your access...</title>
  <style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#fafafa;color:#333}main{text-align:center;padding:2rem}.spinner{width:40px;height:40px;border:4px solid #e0e0e0;border-top-color:#333;border-radius:50%;animation:spin .8s linear infinite;margin:1rem auto}@keyframes spin{to{transform:rotate(360deg)}}</style>
</head>
<body>
  <main role="status" aria-live="polite">
    <div class="spinner" aria-hidden="true"></div>
    <p>Verifying your access&hellip;</p>
    <noscript><p><strong>JavaScript is required to verify your access. Please enable JavaScript and reload this page.</strong></p></noscript>
  </main>
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
  if (secret === 'default-secret-change-me') {
    if (debug) {
      gateLog('warn', 'Using default CHALLENGE_SECRET. Set a strong secret before deploying to production.');
    } else {
      throw new Error('[gate] CHALLENGE_SECRET is set to the insecure default. Set a strong, unique secret for production.');
    }
  }
  const walletAddress = homeWalletAddress || '';
  if (walletAddress && !BASE58_RE.test(walletAddress)) {
    throw new Error(`[gate] HOME_WALLET_ADDRESS "${walletAddress}" is not a valid Solana public key (expected 32-44 base58 characters).`);
  }
  const rpcUrl = solanaRpcUrl || (debug ? RPC_DEVNET : RPC_MAINNET);
  const mint = usdcMint || (debug ? USDC_MINT_DEVNET : USDC_MINT_MAINNET);
  const network = debug ? 'devnet' : 'mainnet-beta';
  const paymentCache = new PaymentCache();
  const rateLimiter = new RateLimiter();
  setInterval(() => rateLimiter.cleanup(), 60000).unref();

  return async function agentPaymentsGateMiddleware(req, res, next) {
    const pathname = req.path;

    if (isPublicPath(pathname)) return next();

    if (pathname === '/__challenge/verify' && req.method === 'POST') {
      const clientIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
      if (!rateLimiter.check(clientIp)) {
        return json(res, 429, { error: 'rate_limited', message: 'Too many verification attempts. Please wait and try again.' });
      }
      const nonce = (req.body?.nonce || req.query?.nonce || '').slice(0, MAX_NONCE_LENGTH);
      const returnTo = (req.body?.return_to || req.query?.return_to || '/').slice(0, MAX_RETURN_TO_LENGTH);
      const fp = (req.body?.fp || req.query?.fp || '').slice(0, MAX_FP_LENGTH);

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
      if (nonceSig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(nonceSig), Buffer.from(expectedSig))) {
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

      const cached = paymentCache.get(agentKey);
      if (cached === true) return next();
      const paid = await verifyPaymentOnChain(agentKey, walletAddress, rpcUrl, mint);
      if (paid) paymentCache.set(agentKey, true);
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
