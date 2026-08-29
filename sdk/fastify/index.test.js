'use strict';
/**
 * Fastify wrapper tests — node:test
 * Run: node --test sdk/fastify/index.test.js
 *
 * Full payment-verification coverage lives in sdk/node/index.test.js (this
 * package just wraps that unmodified gate via @fastify/express); these
 * tests confirm the wiring itself works — unpaid requests get the real
 * 402 JSON, public paths pass through — proving the Express-compat layer
 * correctly exposes req.path/res.status/etc. to the gate.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Fastify = require('fastify');
const { agentPaymentsFastify } = require('./index.js');

// @fastify/express bridges into real Express internals, which don't behave
// identically against Fastify's simulated inject() request/response (empty
// bodies observed) vs a real socket — use a real listening server instead,
// which is also what actually gets exercised in production.
function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('agentPaymentsFastify', () => {
  let fastify;
  let port;

  before(async () => {
    fastify = Fastify();
    await fastify.register(agentPaymentsFastify, {
      challengeSecret: 'fastify-test-secret-32-bytes-long',
      homeWalletAddress: '5rXZeAEbg13DQnSFijEno2hKEJLK2p14fAo3AmPtfBft',
      debug: true,
    });
    fastify.get('/protected', async () => ({ ok: true }));
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    port = fastify.server.address().port;
  });

  after(async () => {
    await fastify.close();
  });

  test('unpaid agent request gets a real 402', async () => {
    const res = await request(port, '/protected', { 'User-Agent': 'test-agent/1.0' });
    assert.equal(res.status, 402);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'payment_required');
    assert.ok(body.your_key.startsWith('ag_'));
  });

  test('public paths pass through without payment', async () => {
    const res = await request(port, '/robots.txt', { 'User-Agent': 'test-agent/1.0' });
    assert.notEqual(res.status, 402);
  });

  test('browser-like request gets the challenge page', async () => {
    const res = await request(port, '/protected', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
    assert.equal(res.status, 200);
    assert.match(res.body, /Verifying your access/);
  });
});
