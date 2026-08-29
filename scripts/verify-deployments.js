#!/usr/bin/env node
/**
 * verify-deployments.js
 *
 * Hits every live AgentPayments deployment this project owns and checks
 * it's actually working — not just "the process is up," but "the behavior
 * a real vendor/agent depends on is correct."
 *
 * Usage:  node scripts/verify-deployments.js [--full]
 *   --full  also exercises the live demo's real devnet payment flow
 *           (costs ~0.01 devnet USDC, takes ~20-30s) instead of just
 *           checking the page loads.
 *
 * Exit 0 = all owned deployments pass. Exit 1 = at least one failed.
 * The three legacy demo URLs from README.md ("Public Demo URLs") belong to
 * the original upstream project (matthew-newell), not this fork — they're
 * checked read-only for information and never affect the exit code.
 */
'use strict';

const https = require('node:https');
const http = require('node:http');

const FULL = process.argv.includes('--full');

function request(url, { method = 'GET', timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method, timeout }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, error: null }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: null, body: '', error: 'timeout' }); });
    req.on('error', (err) => resolve({ status: null, body: '', error: err.message }));
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

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const mark = pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function checkLanding() {
  const res = await request('https://agentpayments.cloud/');
  record('landing: agentpayments.cloud loads', res.status === 200 && res.body.includes('AgentPayments'),
    res.error || `status ${res.status}`);
}

async function checkApi() {
  const dash = await request('https://api.agentpayments.cloud/dashboard');
  record('api: /dashboard loads', dash.status === 200, dash.error || `status ${dash.status}`);

  const account = await request('https://api.agentpayments.cloud/v1/account');
  record('api: /v1/account rejects unauthenticated requests', account.status === 401,
    account.error || `status ${account.status} (expected 401)`);
}

async function checkDemo() {
  // Custom domain may still be propagating DNS; fall back to the Railway URL.
  const candidates = ['https://demo.agentpayments.cloud/', 'https://demo-production-8c4a.up.railway.app/'];
  let res;
  let usedUrl;
  for (const url of candidates) {
    res = await request(url);
    if (res.status === 200) { usedUrl = url; break; }
  }
  record('demo: live demo page loads', res.status === 200,
    usedUrl ? `via ${usedUrl}` : (res.error || `status ${res.status}`));

  if (FULL && usedUrl) {
    const runUrl = usedUrl.replace(/\/$/, '') + '/api/run-demo';
    const { events, error } = await streamSSE(runUrl);
    const granted = events.find((e) => e.step === 'granted');
    const errored = events.find((e) => e.step === 'error');
    record('demo: full live payment flow completes (real devnet tx)', Boolean(granted) && !errored,
      error || (errored ? errored.message : `${events.length} events, last step: ${events.at(-1)?.step}`));
  } else if (FULL) {
    record('demo: full live payment flow completes (real devnet tx)', false, 'could not reach demo to run it');
  }
}

async function checkPublishedPackages() {
  const npmNode = await request('https://registry.npmjs.org/@agentpayments/node/latest');
  const npmEdge = await request('https://registry.npmjs.org/@agentpayments/edge/latest');
  const pypi = await request('https://pypi.org/pypi/agentpayments-python/json');

  try {
    const v = JSON.parse(npmNode.body).version;
    record('npm: @agentpayments/node resolves', Boolean(v), `v${v}`);
  } catch { record('npm: @agentpayments/node resolves', false, npmNode.error || `status ${npmNode.status}`); }

  try {
    const v = JSON.parse(npmEdge.body).version;
    record('npm: @agentpayments/edge resolves', Boolean(v), `v${v}`);
  } catch { record('npm: @agentpayments/edge resolves', false, npmEdge.error || `status ${npmEdge.status}`); }

  try {
    const v = JSON.parse(pypi.body).info.version;
    record('pypi: agentpayments-python resolves', Boolean(v), `v${v}`);
  } catch { record('pypi: agentpayments-python resolves', false, pypi.error || `status ${pypi.status}`); }
}

async function checkLegacyDemos() {
  console.log('\n--- informational only (upstream project, not this fork\'s infra) ---');
  const legacy = [
    ['Cloudflare Worker (matthew-newell)', 'https://agentpayments-cloudflare.matthew-newell.workers.dev/'],
    ['Django Oracle VM (matthew-newell)', 'https://clankertax.tearsheet.one/'],
    ['Next.js/Vercel (matthew-newell)', 'https://nextjsdeployment-five.vercel.app/'],
  ];
  for (const [name, url] of legacy) {
    const res = await request(url, { timeout: 8000 });
    const reachable = res.status !== null;
    console.log(`  ${reachable ? 'ⓘ' : '✗'} ${name}: ${reachable ? `status ${res.status}` : (res.error || 'unreachable')}`);
  }
}

async function main() {
  console.log(`Verifying AgentPayments deployments${FULL ? ' (--full)' : ''}...\n`);
  await checkLanding();
  await checkApi();
  await checkDemo();
  await checkPublishedPackages();
  await checkLegacyDemos();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} owned checks passed.`);
  if (failed.length) {
    console.log('Failed:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main();
