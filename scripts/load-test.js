#!/usr/bin/env node
/**
 * load-test.js
 *
 * Floods a local instance of the Node gate to confirm the rate-limiter DoS
 * mitigations (ROADMAP.md P0 #4) actually hold under concurrent load. Runs
 * entirely offline, against localhost only — never live infrastructure.
 *
 * The rate-limiter checks run *before* any on-chain RPC call in the gate's
 * request flow, so no real Solana RPC or funds are needed: requests that
 * clear the limiter just hit `homeWalletAddress: ''`'s "unavailable" 500
 * short-circuit instead of attempting a chain scan. Deliberately dependency-
 * free (no Express) — a minimal req/res shim over node:http, matching the
 * style of scripts/verify-deployments.js and scripts/e2e-demo.js.
 *
 * Usage:  node scripts/load-test.js
 * Exit 0 = all limiters held correctly. Exit 1 = a limiter was breached.
 */
'use strict';

const http = require('node:http');
const { agentPaymentsGate } = require('../sdk/node/index.js');

const SECRET = 'load-test-secret-not-for-production';
const AGENT_KEY_RATE_LIMIT_MAX = 10;
const CHALLENGE_ISSUE_RATE_LIMIT_MAX = 30;

const gate = agentPaymentsGate({
  challengeSecret: SECRET,
  homeWalletAddress: '', // rate limiter runs before this would ever matter — keeps the whole test offline
  debug: true,
});

function shimReq(rawReq) {
  const [path] = rawReq.url.split('?');
  rawReq.path = path;
  rawReq.originalUrl = rawReq.url;
  rawReq.get = (name) => rawReq.headers[name.toLowerCase()];
  // Trust X-Forwarded-For, matching a real deployment behind a reverse proxy
  // (Express's app.set('trust proxy', true)) — lets the flood simulate
  // requests arriving from multiple distinct client IPs.
  rawReq.ip = (rawReq.headers['x-forwarded-for'] || '').split(',')[0].trim() || rawReq.socket.remoteAddress;
  return rawReq;
}

function shimRes(rawRes) {
  rawRes.status = function (code) { this.statusCode = code; return this; };
  rawRes.set = function (name, value) { this.setHeader(name, value); return this; };
  rawRes.send = function (body) { this.end(body); return this; };
  return rawRes;
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((rawReq, rawRes) => {
      const req = shimReq(rawReq);
      const res = shimRes(rawRes);
      gate(req, res, () => { res.status(200).send('ok'); });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function requestOnce(port, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: null, body: '' }));
    req.end();
  });
}

async function getFreshAgentKey(port, ip) {
  // A no-key request issues one in the 402 body's your_key field, without
  // touching the agent-key rate limiter (that check only runs once a key is
  // present) — so this doesn't count against the flood's budget.
  const { body } = await requestOnce(port, { 'Sec-Fetch-Mode': 'cors', 'X-Forwarded-For': ip });
  try { return JSON.parse(body).your_key; } catch { return null; }
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const mark = pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function floodAgentKeyPath(port, ip, count) {
  const key = await getFreshAgentKey(port, ip);
  if (!key) { record(`agent-key path (${ip})`, false, 'failed to obtain a fresh agent key'); return null; }
  const responses = await Promise.all(
    Array.from({ length: count }, () => requestOnce(port, { 'Sec-Fetch-Mode': 'cors', 'X-Agent-Key': key, 'X-Forwarded-For': ip }))
  );
  const statuses = responses.map((r) => r.status);
  const allowed = statuses.filter((s) => s !== 429).length;
  record(`agent-key path (${ip}): caps at ${AGENT_KEY_RATE_LIMIT_MAX}/min, rest get 429`,
    allowed <= AGENT_KEY_RATE_LIMIT_MAX,
    `${allowed} allowed through, ${count - allowed} rate-limited (sent ${count})`);
  return allowed;
}

async function floodChallengeIssuePath(port, ip, count) {
  const responses = await Promise.all(
    Array.from({ length: count }, () => requestOnce(port, { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'X-Forwarded-For': ip }))
  );
  const statuses = responses.map((r) => r.status);
  const allowed = statuses.filter((s) => s !== 429).length;
  record(`challenge-issue path (${ip}): caps at ${CHALLENGE_ISSUE_RATE_LIMIT_MAX}/min, rest get 429`,
    allowed <= CHALLENGE_ISSUE_RATE_LIMIT_MAX,
    `${allowed} allowed through, ${count - allowed} rate-limited (sent ${count})`);
}

async function main() {
  console.log('Starting a local gate instance for load testing (fully offline — no RPC calls, no live infra touched)...\n');
  const { server, port } = await startServer();
  try {
    await floodAgentKeyPath(port, '10.0.0.1', AGENT_KEY_RATE_LIMIT_MAX + 15);
    await floodChallengeIssuePath(port, '10.0.0.2', CHALLENGE_ISSUE_RATE_LIMIT_MAX + 15);

    // A second, independent IP must get its own full budget rather than
    // sharing the first IP's already-exhausted one — proves the limiter
    // keys per-IP, not globally.
    const allowedForFreshIp = await floodAgentKeyPath(port, '10.0.0.3', AGENT_KEY_RATE_LIMIT_MAX);
    record('agent-key path: a fresh IP gets its own independent budget',
      allowedForFreshIp === AGENT_KEY_RATE_LIMIT_MAX,
      `${allowedForFreshIp}/${AGENT_KEY_RATE_LIMIT_MAX} allowed through on a request count exactly at the limit`);
  } finally {
    server.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('Failed:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main();
