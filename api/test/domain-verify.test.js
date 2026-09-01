'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidDomainFormat, isPrivateOrReservedIp, resolvesToPublicIp, verifyDomainOwnership } = require('../domain-verify');

test('isValidDomainFormat accepts plausible public hostnames', () => {
  assert.equal(isValidDomainFormat('example.com'), true);
  assert.equal(isValidDomainFormat('sub.example.co.uk'), true);
  assert.equal(isValidDomainFormat('my-app.example.com'), true);
});

test('isValidDomainFormat rejects scheme/path/port/userinfo and single-label hosts', () => {
  assert.equal(isValidDomainFormat('https://example.com'), false);
  assert.equal(isValidDomainFormat('example.com/path'), false);
  assert.equal(isValidDomainFormat('example.com:8080'), false);
  assert.equal(isValidDomainFormat('user@example.com'), false);
  assert.equal(isValidDomainFormat('localhost'), false);
  assert.equal(isValidDomainFormat(''), false);
  assert.equal(isValidDomainFormat(null), false);
  assert.equal(isValidDomainFormat(123), false);
});

test('isValidDomainFormat rejects internal-looking TLDs', () => {
  assert.equal(isValidDomainFormat('service.internal'), false);
  assert.equal(isValidDomainFormat('app.local'), false);
  assert.equal(isValidDomainFormat('foo.test'), false);
});

test('isPrivateOrReservedIp flags RFC1918, loopback, link-local (incl. cloud metadata), multicast', () => {
  assert.equal(isPrivateOrReservedIp('10.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('172.16.5.4'), true);
  assert.equal(isPrivateOrReservedIp('192.168.1.1'), true);
  assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('169.254.169.254'), true); // cloud metadata endpoint
  assert.equal(isPrivateOrReservedIp('224.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('::1'), true);
  assert.equal(isPrivateOrReservedIp('fe80::1'), true);
  assert.equal(isPrivateOrReservedIp('fc00::1'), true);
});

test('isPrivateOrReservedIp allows plausible public addresses', () => {
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
  assert.equal(isPrivateOrReservedIp('1.1.1.1'), false);
  assert.equal(isPrivateOrReservedIp('2606:4700:4700::1111'), false);
});

test('resolvesToPublicIp returns false for a hostname that fails to resolve', async () => {
  const resolved = await resolvesToPublicIp('this-domain-should-not-exist-agentpayments-zzqqxx123.com');
  assert.equal(resolved, false);
});

test('verifyDomainOwnership rejects an invalid domain before any network call', async () => {
  const result = await verifyDomainOwnership('not a domain', 'sometoken');
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'invalid_domain');
});

test('verifyDomainOwnership rejects a hostname that fails DNS resolution', async () => {
  const result = await verifyDomainOwnership('this-domain-should-not-exist-agentpayments-zzqqxx123.com', 'sometoken');
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'domain_not_public');
});

// The following tests mock global.fetch to exercise the post-DNS logic
// deterministically, without depending on any real HTTP response body. DNS
// resolution against example.com (RFC 2606 reserved, always resolves) still runs
// for real, so resolvesToPublicIp isn't bypassed.
function withMockedFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return fn().finally(() => { global.fetch = original; });
}

function fakeTextResponse(status, text) {
  return {
    status,
    body: { getReader: undefined },
    text: async () => text,
  };
}

test('verifyDomainOwnership succeeds when the response body matches the token exactly', () => withMockedFetch(
  async () => fakeTextResponse(200, '  the-expected-token  \n'),
  async () => {
    const result = await verifyDomainOwnership('example.com', 'the-expected-token');
    assert.equal(result.verified, true);
  },
));

test('verifyDomainOwnership fails when the response body does not match the token', () => withMockedFetch(
  async () => fakeTextResponse(200, 'wrong-value'),
  async () => {
    const result = await verifyDomainOwnership('example.com', 'the-expected-token');
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'token_mismatch');
  },
));

test('verifyDomainOwnership never follows a redirect', () => withMockedFetch(
  async () => fakeTextResponse(302, ''),
  async () => {
    const result = await verifyDomainOwnership('example.com', 'the-expected-token');
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'redirect_not_followed');
  },
));

test('verifyDomainOwnership rejects a non-200, non-redirect status', () => withMockedFetch(
  async () => fakeTextResponse(404, ''),
  async () => {
    const result = await verifyDomainOwnership('example.com', 'the-expected-token');
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'unexpected_status_404');
  },
));

test('verifyDomainOwnership surfaces a network error without throwing', () => withMockedFetch(
  async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  async () => {
    const result = await verifyDomainOwnership('example.com', 'the-expected-token');
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'fetch_failed');
  },
));
