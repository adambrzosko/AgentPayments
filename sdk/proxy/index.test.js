'use strict';
/**
 * Proxy adapter tests — node:test
 * Run: node --test sdk/proxy/index.test.js
 *
 * Full payment-verification coverage lives in sdk/node/index.test.js (this
 * package just wraps that gate + a reverse proxy); these tests cover what's
 * specific to the proxy: config validation, blocking unpaid requests before
 * they reach the upstream, and passing public paths straight through to a
 * real (non-Node) backend.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.CHALLENGE_SECRET = 'proxy-test-secret-32-bytes-long-abc';
process.env.HOME_WALLET_ADDRESS = '5rXZeAEbg13DQnSFijEno2hKEJLK2p14fAo3AmPtfBft';
process.env.DEBUG = 'true';

const { buildApp } = require('./index.js');

function request(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('buildApp', () => {
  test('throws without an upstream URL', () => {
    assert.throws(() => buildApp({ upstreamUrl: undefined }), /UPSTREAM_URL is required/);
  });
});

describe('gate enforcement', () => {
  let upstream;
  let proxyServer;

  before(async () => {
    upstream = http.createServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('User-agent: *\nAllow: /');
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('real backend response');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

    const { app } = buildApp({ upstreamUrl });
    proxyServer = http.createServer(app);
    await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => proxyServer.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });

  test('unpaid agent request gets 402 and never reaches the upstream', async () => {
    const res = await request(proxyServer, '/', { 'User-Agent': 'test-agent/1.0' });
    assert.equal(res.status, 402);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'payment_required');
    assert.ok(body.your_key.startsWith('ag_'));
    assert.notEqual(body.body, 'real backend response');
  });

  test('public paths pass through to the real upstream without payment', async () => {
    const res = await request(proxyServer, '/robots.txt', { 'User-Agent': 'test-agent/1.0' });
    assert.equal(res.status, 200);
    assert.match(res.body, /Allow: \//);
  });
});
