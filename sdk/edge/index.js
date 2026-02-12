// Values sourced from sdk/constants.json (canonical). Inlined here because JSON
// import syntax differs across Deno (Netlify), Cloudflare Workers, and Vercel Edge.
const COOKIE_NAME = '__agp_verified';
const COOKIE_MAX_AGE = 86400;
const KEY_PREFIX = 'ag_';
const MIN_PAYMENT = 0.01;
const MAX_KEY_LENGTH = 64;
const MAX_NONCE_LENGTH = 128;
const MAX_RETURN_TO_LENGTH = 2048;
const MAX_FP_LENGTH = 128;
const PAYMENT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const PAYMENT_CACHE_MAX = 1000;

const paymentCache = new Map();

function getCachedPayment(key) {
  const entry = paymentCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > PAYMENT_CACHE_TTL) { paymentCache.delete(key); return undefined; }
  return entry.value;
}

function setCachedPayment(key, value) {
  if (paymentCache.size >= PAYMENT_CACHE_MAX) {
    const oldest = paymentCache.keys().next().value;
    paymentCache.delete(oldest);
  }
  paymentCache.set(key, { value, ts: Date.now() });
}

function gateLog(level, message, data = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, component: 'agentpayments', message, ...data });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 20;
const rateLimitHits = new Map();

function rateLimitCheck(key) {
  const now = Date.now();
  const entry = rateLimitHits.get(key);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimitHits.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode('timing-safe-cmp'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [macA, macB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ]);
  const viewA = new Uint8Array(macA);
  const viewB = new Uint8Array(macB);
  let result = 0;
  for (let i = 0; i < viewA.length; i++) result |= viewA[i] ^ viewB[i];
  return result === 0;
}

async function generateAgentKey(secret) {
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const sig = await hmacSign(random, secret);
  return `${KEY_PREFIX}${random}_${sig.slice(0, 16)}`;
}

async function isValidAgentKey(key, secret) {
  if (!key || key.length > MAX_KEY_LENGTH || !key.startsWith(KEY_PREFIX)) return false;
  const rest = key.slice(KEY_PREFIX.length);
  const underscoreIndex = rest.indexOf('_');
  if (underscoreIndex === -1) return false;
  const random = rest.slice(0, underscoreIndex);
  const sig = rest.slice(underscoreIndex + 1);
  const expected = await hmacSign(random, secret);
  return timingSafeEqual(sig, expected.slice(0, 16));
}

async function derivePaymentMemo(agentKey, secret) {
  const sig = await hmacSign(agentKey, secret);
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

const merchantConfigCache = new Map();

async function fetchMerchantConfig(verifyUrl, apiKey) {
  const cached = merchantConfigCache.get(apiKey);
  if (cached) return cached;
  const baseUrl = verifyUrl.replace(/\/verify\/?$/, '');
  const resp = await fetch(`${baseUrl}/merchants/me`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch merchant config: HTTP ${resp.status}`);
  }
  const config = await resp.json();
  merchantConfigCache.set(apiKey, config);
  return config;
}

function getCookie(request, name) {
  const cookies = request.headers.get('cookie') || '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function isValidCookie(request, secret) {
  const cookie = getCookie(request, COOKIE_NAME);
  if (!cookie) return false;
  const dotIndex = cookie.indexOf('.');
  if (dotIndex === -1) return false;
  const timestamp = cookie.slice(0, dotIndex);
  const signature = cookie.slice(dotIndex + 1);
  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Date.now() - ts > COOKIE_MAX_AGE * 1000) return false;
  const expected = await hmacSign(timestamp, secret);
  return timingSafeEqual(signature, expected);
}

function isPublicPath(pathname, allowlist = []) {
  if (pathname === '/robots.txt') return true;
  if (pathname.startsWith('/.well-known/')) return true;
  if (allowlist.includes(pathname)) return true;
  return false;
}

function isBrowser(request) {
  return Boolean(request.headers.get('sec-fetch-mode') || request.headers.get('sec-fetch-dest'));
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}

function challengePage(returnTo, nonce) {
  const safePath = returnTo.startsWith('/') ? returnTo : '/';
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Verifying your access...</title><style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#fafafa;color:#333}main{text-align:center;padding:2rem}.spinner{width:40px;height:40px;border:4px solid #e0e0e0;border-top-color:#333;border-radius:50%;animation:spin .8s linear infinite;margin:1rem auto}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><main role="status" aria-live="polite"><div class="spinner" aria-hidden="true"></div><p>Verifying your access&hellip;</p><noscript><p><strong>JavaScript is required to verify your access. Please enable JavaScript and reload this page.</strong></p></noscript></main><script>(function(){if(navigator.webdriver)return;var c=document.createElement("canvas");c.width=200;c.height=50;var ctx=c.getContext("2d");if(!ctx)return;ctx.font="18px Arial";ctx.fillStyle="#1a1a2e";ctx.fillText("verify",10,30);var data=c.toDataURL();if(!data||data.length<100)return;if(typeof window.innerWidth==="undefined"||window.innerWidth===0)return;var form=document.createElement("form");form.method="POST";form.action="/__challenge/verify";var fields={nonce:${JSON.stringify(nonce)},return_to:${JSON.stringify(safePath)},fp:data.slice(22,86)};for(var key in fields){var input=document.createElement("input");input.type="hidden";input.name=key;input.value=fields[key];form.appendChild(input);}document.body.appendChild(form);form.submit();})();</script></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
}

export function createEdgeGate(options = {}) {
  const {
    fetchUpstream,
    getClientIp = () => 'unknown',
    publicPathAllowlist = [],
    minPayment = MIN_PAYMENT,
    envResolver,
  } = options;

  if (typeof fetchUpstream !== 'function') {
    throw new Error('createEdgeGate requires fetchUpstream(request, env, context)');
  }

  return async function edgeGate(request, env = {}, context = {}) {
    const effectiveEnv = envResolver ? await envResolver({ request, env, context }) : env;
    const url = new URL(request.url);
    const browser = isBrowser(request);
    const agentKey = request.headers.get('X-Agent-Key');
    console.log(`[gate] ${request.method} ${url.pathname} | browser=${browser} | agent-key=${agentKey ? agentKey.slice(0, 12) + '...' : 'none'}`);
    const secret = effectiveEnv.CHALLENGE_SECRET || 'default-secret-change-me';
    if (secret === 'default-secret-change-me') {
      gateLog('warn', 'Using default CHALLENGE_SECRET. Set a strong secret before deploying to production.');
    }
    const verifyUrl = effectiveEnv.AGENTPAYMENTS_VERIFY_URL || '';
    const apiKey = effectiveEnv.AGENTPAYMENTS_API_KEY || '';

    async function getMerchantConfig() {
      if (!verifyUrl || !apiKey) return null;
      return fetchMerchantConfig(verifyUrl, apiKey);
    }

    if (isPublicPath(url.pathname, publicPathAllowlist)) {
      return fetchUpstream(request, effectiveEnv, context);
    }

    if (url.pathname === '/__challenge/verify' && request.method === 'POST') {
      const clientIp = getClientIp({ request, env: effectiveEnv, context });
      if (!rateLimitCheck(clientIp)) {
        return jsonResponse({ error: 'rate_limited', message: 'Too many verification attempts. Please wait and try again.' }, 429);
      }
      const formData = await request.formData();
      const nonce = (formData.get('nonce')?.toString() || '').slice(0, MAX_NONCE_LENGTH);
      const returnTo = (formData.get('return_to')?.toString() || '/').slice(0, MAX_RETURN_TO_LENGTH);
      const fp = (formData.get('fp')?.toString() || '').slice(0, MAX_FP_LENGTH);

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
      if (!(await timingSafeEqual(nonceSig, expectedSig))) {
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
        const mc = await getMerchantConfig();
        if (!mc) return jsonResponse({ error: 'server_error', message: 'Payment verification not configured.' }, 500);
        const newKey = await generateAgentKey(secret);
        const paymentMemo = await derivePaymentMemo(newKey, secret);
        const networkLabel = mc.network === 'devnet' ? 'devnet' : 'mainnet';
        return jsonResponse({
          error: 'payment_required',
          message: 'Access requires a paid API key. A key has been generated for you below. Send a USDC payment with the provided memo to activate it, then retry your request with the X-Agent-Key header.',
          your_key: newKey,
          payment: {
            chain: 'solana',
            network: mc.network === 'devnet' ? 'devnet' : 'mainnet-beta',
            token: 'USDC',
            amount: String(minPayment),
            wallet_address: mc.walletAddress,
            memo: paymentMemo,
            instructions: `Send ${minPayment} USDC on Solana ${networkLabel} to ${mc.walletAddress} with memo "${paymentMemo}". Then include the header X-Agent-Key: ${newKey} on all subsequent requests.`,
          },
        }, 402);
      }

      if (!(await isValidAgentKey(agentKey, secret))) {
        return jsonResponse({
          error: 'forbidden',
          message: 'Invalid API key. Keys must be issued by this server.',
          details: 'GET /.well-known/agent-access.json for access instructions.',
        }, 403);
      }

      if (getCachedPayment(agentKey) === true) {
        return fetchUpstream(request, effectiveEnv, context);
      }

      if (!verifyUrl || !apiKey) {
        return jsonResponse({ error: 'server_error', message: 'Payment verification not configured.' }, 500);
      }

      const paymentMemo = await derivePaymentMemo(agentKey, secret);
      const paid = await verifyPaymentViaBackend(paymentMemo, verifyUrl, apiKey);
      if (paid) setCachedPayment(agentKey, true);
      if (!paid) {
        const mc = await getMerchantConfig();
        if (!mc) return jsonResponse({ error: 'server_error', message: 'Payment verification not configured.' }, 500);
        return jsonResponse({
          error: 'payment_required',
          message: 'Key is valid but payment has not been verified yet. Please send the USDC payment and allow a few moments for confirmation.',
          your_key: agentKey,
          payment: {
            chain: 'solana',
            network: mc.network === 'devnet' ? 'devnet' : 'mainnet-beta',
            token: 'USDC',
            amount: String(minPayment),
            wallet_address: mc.walletAddress,
            memo: paymentMemo,
          },
        }, 402);
      }

      const ua = request.headers.get('user-agent') || 'unknown';
      const ip = getClientIp({ request, env: effectiveEnv, context });
      gateLog('info', 'Payment verified - agent access granted', { network: 'verified', key: agentKey.slice(0, 12) + '...', ua, ip, path: url.pathname });
      return fetchUpstream(request, effectiveEnv, context);
    }

    if (await isValidCookie(request, secret)) {
      return fetchUpstream(request, effectiveEnv, context);
    }

    const nonceTs = Date.now().toString();
    const nonceSig = await hmacSign(`nonce:${nonceTs}`, secret);
    return challengePage(url.pathname + url.search, `${nonceTs}.${nonceSig}`);
  };
}
