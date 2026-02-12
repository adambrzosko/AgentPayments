const crypto = require('node:crypto');
const {
  COOKIE_NAME, COOKIE_MAX_AGE, KEY_PREFIX,
  MIN_PAYMENT,
  MAX_KEY_LENGTH, MAX_NONCE_LENGTH, MAX_RETURN_TO_LENGTH, MAX_FP_LENGTH,
} = require('../constants.json');
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

function derivePaymentMemo(agentKey, secret) {
  const sig = hmacSign(agentKey, secret);
  return `gm_${sig.slice(0, 16)}`;
}

async function verifyPaymentViaBackend(memo, verifyUrl, apiKey) {
  const url = `${verifyUrl}?memo=${encodeURIComponent(memo)}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    gateLog('error', 'Backend verification request failed', { status: resp.status });
    return false;
  }
  const data = await resp.json();
  return data.paid === true;
}

async function fetchMerchantConfig(verifyUrl, apiKey) {
  const baseUrl = verifyUrl.replace(/\/verify\/?$/, '');
  const resp = await fetch(`${baseUrl}/merchants/me`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch merchant config: HTTP ${resp.status}`);
  }
  return resp.json();
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
    verifyUrl,
    apiKey,
  } = config;

  const secret = challengeSecret || 'default-secret-change-me';
  if (secret === 'default-secret-change-me') {
    gateLog('warn', 'Using default CHALLENGE_SECRET. Set a strong secret before deploying to production.');
  }
  const paymentCache = new PaymentCache();
  const rateLimiter = new RateLimiter();
  setInterval(() => rateLimiter.cleanup(), 60000).unref();

  let merchantConfig = null;
  async function getMerchantConfig() {
    if (merchantConfig) return merchantConfig;
    if (!verifyUrl || !apiKey) return null;
    merchantConfig = await fetchMerchantConfig(verifyUrl, apiKey);
    return merchantConfig;
  }

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
        const mc = await getMerchantConfig();
        if (!mc) return json(res, 500, { error: 'server_error', message: 'Payment verification not configured.' });
        const newKey = generateAgentKey(secret);
        const paymentMemo = derivePaymentMemo(newKey, secret);
        const networkLabel = mc.network === 'devnet' ? 'devnet' : 'mainnet';
        return json(res, 402, {
          error: 'payment_required',
          message: 'Access requires a paid API key. A key has been generated for you below. Send a USDC payment with the provided memo to activate it, then retry your request with the X-Agent-Key header.',
          your_key: newKey,
          payment: {
            chain: 'solana',
            network: mc.network === 'devnet' ? 'devnet' : 'mainnet-beta',
            token: 'USDC',
            amount: String(MIN_PAYMENT),
            wallet_address: mc.walletAddress,
            memo: paymentMemo,
            instructions: `Send ${MIN_PAYMENT} USDC on Solana ${networkLabel} to ${mc.walletAddress} with memo "${paymentMemo}". Then include the header X-Agent-Key: ${newKey} on all subsequent requests.`,
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

      const cached = paymentCache.get(agentKey);
      if (cached === true) return next();

      if (!verifyUrl || !apiKey) {
        return json(res, 500, { error: 'server_error', message: 'Payment verification not configured.' });
      }

      const paymentMemo = derivePaymentMemo(agentKey, secret);
      const paid = await verifyPaymentViaBackend(paymentMemo, verifyUrl, apiKey);
      if (paid) paymentCache.set(agentKey, true);
      if (!paid) {
        const mc = await getMerchantConfig();
        if (!mc) return json(res, 500, { error: 'server_error', message: 'Payment verification not configured.' });
        return json(res, 402, {
          error: 'payment_required',
          message: 'Key is valid but payment has not been verified yet. Please send the USDC payment and allow a few moments for confirmation.',
          your_key: agentKey,
          payment: {
            chain: 'solana',
            network: mc.network === 'devnet' ? 'devnet' : 'mainnet-beta',
            token: 'USDC',
            amount: String(MIN_PAYMENT),
            wallet_address: mc.walletAddress,
            memo: paymentMemo,
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
