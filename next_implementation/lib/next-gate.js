import { NextResponse } from 'next/server';

const COOKIE_NAME = '__agp_verified';
const COOKIE_MAX_AGE = 86400;

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isPublicPath(pathname, allowlist = []) {
  return pathname === '/robots.txt' || pathname.startsWith('/.well-known/') || allowlist.includes(pathname);
}

function isBrowser(request) {
  return Boolean(request.headers.get('sec-fetch-mode') || request.headers.get('sec-fetch-dest'));
}

function getCookie(request, name) {
  const cookies = request.headers.get('cookie') || '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function isValidCookie(request, secret) {
  const cookie = getCookie(request, COOKIE_NAME);
  if (!cookie) return false;
  const i = cookie.indexOf('.');
  if (i === -1) return false;
  const timestamp = cookie.slice(0, i);
  const signature = cookie.slice(i + 1);
  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Date.now() - ts > COOKIE_MAX_AGE * 1000) return false;
  return signature === await hmacSign(timestamp, secret);
}

function challengePage(returnTo, nonce) {
  const safePath = returnTo.startsWith('/') ? returnTo : '/';
  const html = `<!DOCTYPE html><html><body><script>(function(){if(navigator.webdriver)return;var c=document.createElement('canvas');c.width=200;c.height=50;var ctx=c.getContext('2d');if(!ctx)return;ctx.font='18px Arial';ctx.fillText('verify',10,30);var d=c.toDataURL();if(!d||d.length<100)return;var f=document.createElement('form');f.method='POST';f.action='/__challenge/verify';var x={nonce:${JSON.stringify(nonce)},return_to:${JSON.stringify(safePath)},fp:d.slice(22,86)};for(var k in x){var i=document.createElement('input');i.type='hidden';i.name=k;i.value=x[k];f.appendChild(i);}document.body.appendChild(f);f.submit();})();</script></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}

export function createNextMiddleware({ publicPathAllowlist = [], minPayment = 0.01 } = {}) {
  return async function middleware(request) {
    const secret = process.env.CHALLENGE_SECRET || 'default-secret-change-me';
    const wallet = process.env.HOME_WALLET_ADDRESS || '';
    const debug = process.env.DEBUG !== 'false';

    const url = new URL(request.url);
    if (isPublicPath(url.pathname, publicPathAllowlist)) return NextResponse.next();

    if (url.pathname === '/__challenge/verify' && request.method === 'POST') {
      const form = await request.formData();
      const nonce = form.get('nonce')?.toString() || '';
      const returnTo = form.get('return_to')?.toString() || '/';
      const fp = form.get('fp')?.toString() || '';
      const i = nonce.indexOf('.');
      if (i === -1 || !fp || fp.length < 10) return json({ error: 'forbidden', message: 'Challenge verification failed.' }, 403);
      const nonceTs = nonce.slice(0, i);
      const nonceSig = nonce.slice(i + 1);
      const ts = Number.parseInt(nonceTs, 10);
      if (Number.isNaN(ts) || Date.now() - ts > 300000) return json({ error: 'forbidden', message: 'Challenge expired.' }, 403);
      if (nonceSig !== await hmacSign(`nonce:${nonceTs}`, secret)) return json({ error: 'forbidden', message: 'Invalid challenge.' }, 403);
      const now = Date.now().toString();
      const cookieSig = await hmacSign(now, secret);
      const res = NextResponse.redirect(new URL(returnTo.startsWith('/') ? returnTo : '/', request.url));
      res.headers.set('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(`${now}.${cookieSig}`)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`);
      return res;
    }

    if (!isBrowser(request)) {
      return json({
        error: 'payment_required',
        message: 'Access requires a paid API key.',
        payment: {
          chain: 'solana',
          network: debug ? 'devnet' : 'mainnet-beta',
          token: 'USDC',
          amount: String(minPayment),
          wallet_address: wallet,
        },
      }, 402);
    }

    if (await isValidCookie(request, secret)) return NextResponse.next();
    const nonceTs = Date.now().toString();
    const nonceSig = await hmacSign(`nonce:${nonceTs}`, secret);
    return challengePage(url.pathname + url.search, `${nonceTs}.${nonceSig}`);
  };
}
