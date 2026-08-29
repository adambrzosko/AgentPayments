'use strict';
/**
 * Koa wrapper tests — node:test
 * Run: node --test sdk/koa/index.test.js
 *
 * Full payment-verification coverage lives in sdk/node/index.test.js (this
 * package just wraps that unmodified gate via a ctx-to-Express-like
 * adapter); these tests confirm the adapter itself works correctly —
 * including the short-circuit-vs-next() resolution path and the manual
 * body parsing for /__challenge/verify.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Koa = require('koa');
const { agentPaymentsKoa } = require('./index.js');

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('agentPaymentsKoa', () => {
  let server;
  let port;

  before(async () => {
    const app = new Koa();
    app.use(agentPaymentsKoa({
      challengeSecret: 'koa-test-secret-32-bytes-long-abc',
      homeWalletAddress: '5rXZeAEbg13DQnSFijEno2hKEJLK2p14fAo3AmPtfBft',
      debug: true,
    }));
    app.use((ctx) => {
      if (ctx.path === '/protected') ctx.body = { ok: true };
    });
    server = http.createServer(app.callback());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('unpaid agent request gets a real 402 (short-circuit path resolves)', async () => {
    const res = await request(port, '/protected', { headers: { 'User-Agent': 'test-agent/1.0' } });
    assert.equal(res.status, 402);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'payment_required');
    assert.ok(body.your_key.startsWith('ag_'));
  });

  test('public paths pass through to downstream middleware (next() path resolves)', async () => {
    // No route for /robots.txt registered downstream, but the gate must
    // still call next() rather than hanging — a 404 (not a 402) proves it.
    const res = await request(port, '/robots.txt', { headers: { 'User-Agent': 'test-agent/1.0' } });
    assert.notEqual(res.status, 402);
  });

  test('browser-like request gets the challenge page', async () => {
    const res = await request(port, '/protected', { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
    assert.equal(res.status, 200);
    assert.match(res.body, /Verifying your access/);
  });

  test('/__challenge/verify parses the urlencoded body without crashing', async () => {
    const res = await request(port, '/__challenge/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'nonce=fake&return_to=/&fp=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&pow=0',
    });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).error, 'forbidden');
  });
});
