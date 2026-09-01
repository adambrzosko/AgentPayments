/**
 * Domain ownership verification.
 *
 * A vendor proves control of a domain by publishing a token at
 * https://{domain}/.well-known/agentpayments-verify.txt — the same public-path
 * convention the SDKs already carve out for `/.well-known/` (see isPublicPath in
 * sdk/node/index.js), so the check never collides with an active gate on that domain.
 *
 * The verification fetch is server-initiated against a vendor-supplied hostname —
 * classic SSRF surface. Mitigations, defense in depth:
 *   1. Strict hostname format (no scheme/path/port/userinfo, rejects internal-looking
 *      TLDs like .local/.internal).
 *   2. Pre-resolve DNS and reject any A/AAAA record in a private/loopback/link-local/
 *      reserved range (rules out cloud metadata endpoints like 169.254.169.254 and
 *      internal service hostnames).
 *   3. HTTPS only, redirects never followed (a redirect is the classic bypass for #2 —
 *      a public-DNS host redirecting to an internal one). A successful fetch also
 *      requires a publicly-trusted TLS cert for the exact hostname, which is the real
 *      backstop: an attacker who can rebind DNS past check #2 still can't produce a
 *      valid cert for an internal target.
 *   4. Bounded timeout and response size.
 */
'use strict';

const dns = require('node:dns').promises;

// One or more labels of letters/digits/hyphens separated by dots — no scheme, path,
// port, or userinfo. Requires at least one dot so single-label internal names
// ("localhost", a bare Railway service name) never pass.
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.invalid', '.test', '.example', '.arpa'];

function isValidDomainFormat(domain) {
  if (typeof domain !== 'string') return false;
  const d = domain.trim().toLowerCase();
  if (!HOSTNAME_RE.test(d)) return false;
  if (BLOCKED_SUFFIXES.some((suf) => d.endsWith(suf))) return false;
  return true;
}

/** RFC1918/loopback/link-local/multicast/reserved — never a legitimate public vendor site. */
function isPrivateOrReservedIp(ip) {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // link-local fe80::/10
    if (lower.startsWith('::ffff:')) return isPrivateOrReservedIp(lower.slice(7)); // IPv4-mapped
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed -> reject
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  if (a >= 224) return true; // multicast/reserved
  return false;
}

async function resolvesToPublicIp(domain) {
  let addresses;
  try {
    addresses = await dns.lookup(domain, { all: true });
  } catch {
    return false;
  }
  if (!addresses.length) return false;
  return addresses.every((a) => !isPrivateOrReservedIp(a.address));
}

const VERIFY_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 4096;

async function readBodyCapped(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  const chunks = [];
  let total = 0;
  try {
    while (total < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8').slice(0, MAX_RESPONSE_BYTES);
}

/**
 * @returns {{verified: boolean, reason?: string}}
 */
async function verifyDomainOwnership(domain, token) {
  if (!isValidDomainFormat(domain)) return { verified: false, reason: 'invalid_domain' };
  if (!(await resolvesToPublicIp(domain))) return { verified: false, reason: 'domain_not_public' };

  const url = `https://${domain}/.well-known/agentpayments-verify.txt`;
  let res;
  try {
    res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      headers: { 'User-Agent': 'AgentPayments-Domain-Verifier/1.0' },
    });
  } catch (err) {
    return { verified: false, reason: 'fetch_failed', detail: err.message };
  }

  if (res.status >= 300 && res.status < 400) return { verified: false, reason: 'redirect_not_followed' };
  if (res.status !== 200) return { verified: false, reason: `unexpected_status_${res.status}` };

  const body = (await readBodyCapped(res)).trim();
  if (body !== token) return { verified: false, reason: 'token_mismatch' };
  return { verified: true };
}

module.exports = { isValidDomainFormat, isPrivateOrReservedIp, resolvesToPublicIp, verifyDomainOwnership };
