#!/usr/bin/env node
/**
 * e2e-demo.js
 *
 * End-to-end check of the real, live, gate-enforced paywall at
 * demo.agentpayments.cloud: browser flow, agent 402 flow, paid-key flow, and
 * public paths — the four categories named in ROADMAP.md's Test Plan.
 *
 * This is a manual/scheduled script (run via `node scripts/e2e-demo.js`, or
 * the `e2e-nightly` GitHub Actions workflow), deliberately NOT wired into the
 * push/PR-triggered CI: the paid-key flow spends real devnet USDC and takes
 * ~20-30s, and running it on every commit would need DEMO_AGENT_SECRET
 * exposed to every PR's CI context for no benefit.
 *
 * Usage:  node scripts/e2e-demo.js
 * Exit 0 = all checks pass. Exit 1 = at least one failed.
 */
'use strict';

const https = require('node:https');
const http = require('node:http');

function request(url, { method = 'GET', headers = {}, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method, headers, timeout }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, error: null }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: null, headers: {}, body: '', error: 'timeout' }); });
    req.on('error', (err) => resolve({ status: null, headers: {}, body: '', error: err.message }));
    req.end();
  });
}

function streamSSE(url, timeout = 60000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const events = [];
    const req = lib.request(url, { method: 'GET', timeout }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (line.startsWith('data: ')) {
            try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ }
          }
        }
      });
      res.on('end', () => resolve({ events, error: null }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ events, error: 'timeout' }); });
    req.on('error', (err) => resolve({ events, error: err.message }));
    req.end();
  });
}

const CANDIDATES = ['https://demo.agentpayments.cloud', 'https://demo-production-8c4a.up.railway.app'];
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const mark = pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function resolveBaseUrl() {
  for (const url of CANDIDATES) {
    const res = await request(url + '/');
    if (res.status === 200) return url;
  }
  return null;
}

async function checkPublicPaths(base) {
  // Neither file exists in demo/public/ today, so the meaningful assertion
  // is "the gate's isPublicPath bypass kicked in" (no 402, no challenge
  // page) — not that the path resolves to real content.
  for (const path of ['/robots.txt', '/.well-known/agent-access.json']) {
    const res = await request(base + path);
    const bypassedGate = res.status !== 402 && !res.body.includes('Verifying your access');
    record(`public path: ${path} bypasses the gate`, bypassedGate, res.error || `status ${res.status}`);
  }
}

async function checkBrowserFlow(base) {
  const res = await request(base + '/api/premium-content', {
    headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'User-Agent': CHROME_UA },
  });
  const isChallengePage = res.status === 200
    && (res.headers['content-type'] || '').includes('text/html')
    && res.body.includes('Verifying your access');
  record('browser flow: real browser navigation gets the JS challenge page', isChallengePage,
    res.error || `status ${res.status}, content-type ${res.headers['content-type']}`);
}

async function checkAgent402Flow(base) {
  const res = await request(base + '/api/premium-content', {
    headers: { 'Sec-Fetch-Mode': 'cors', 'User-Agent': 'e2e-demo-script/1.0' },
  });
  let body = null;
  try { body = JSON.parse(res.body); } catch { /* leave null */ }
  const isValid402 = res.status === 402
    && body?.x402Version === 1
    && Array.isArray(body?.accepts)
    && body.accepts[0]?.scheme === 'exact'
    && typeof body?.your_key === 'string'
    && body.your_key.startsWith('ag_');
  record('agent 402 flow: fetch()-shaped agent request gets machine-readable 402 JSON', isValid402,
    res.error || `status ${res.status}, your_key ${body?.your_key ?? 'missing'}`);
}

async function checkPaidKeyFlow(base) {
  const { events, error } = await streamSSE(base + '/api/run-demo');
  const granted = events.find((e) => e.step === 'granted');
  const errored = events.find((e) => e.step === 'error');
  record('paid-key flow: real devnet payment -> retry -> granted', Boolean(granted) && !errored,
    error || (errored ? errored.message : `${events.length} events, last step: ${events.at(-1)?.step}`));
}

async function main() {
  console.log('Running E2E check against the live demo (demo.agentpayments.cloud)...\n');

  const base = await resolveBaseUrl();
  if (!base) {
    record('demo: reachable', false, 'neither demo.agentpayments.cloud nor the Railway fallback responded with 200');
    process.exit(1);
  }
  record('demo: reachable', true, `via ${base}`);

  await checkPublicPaths(base);
  await checkBrowserFlow(base);
  await checkAgent402Flow(base);
  await checkPaidKeyFlow(base); // real devnet transaction, ~20-30s

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('Failed:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main();
