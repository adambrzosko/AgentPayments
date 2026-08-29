import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentPaymentsWorker, CloudflareKVStore } from '../cloudflare.js';
import { createNetlifyGate } from '../netlify.js';
import { createVercelEdgeGate } from '../vercel.js';
import { InMemoryStore, generateAgentKey } from '../index.js';

// These wrappers previously only threaded a handful of options (minPayment,
// powDifficulty, publicPathAllowlist) into createEdgeGate — accessDuration/
// pricingTiers/routes (added for the pricing model) and store/getStore
// (needed for a durable state backend on Netlify/Vercel, which have no
// built-in KV binding like Cloudflare) were silently dropped. These tests
// confirm the full option set now reaches the underlying gate.

const ENV = { CHALLENGE_SECRET: 'test-secret-edge', HOME_WALLET_ADDRESS: '5rXZeAEbg13DQnSFijEno2hKEJLK2p14fAo3AmPtfBft', DEBUG: 'true' };

// Short-circuits any on-chain scan with "vendor has no USDC account yet" so
// tests that reach the payment-verification path never hit the real network.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function mockNoAtaRpc() {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: [] } }) });
}

test('createAgentPaymentsWorker threads routes/accessDuration into the gate', async () => {
  const worker = createAgentPaymentsWorker({
    minPayment: 0.01,
    routes: [{ pathPrefix: '/premium', minPayment: 0.05 }],
    assetsBinding: 'ASSETS',
  });
  const req = new Request('https://x.com/premium/data');
  const resp = await worker.fetch(req, { ...ENV, ASSETS: { fetch: async () => new Response('ok') } }, {});
  const body = await resp.json();
  assert.equal(body.payment.amount, '0.05');
});

test('createAgentPaymentsWorker accepts a getStore override', async () => {
  let usedCustomStore = false;
  const customStore = new InMemoryStore();
  const originalCheckRateLimit = customStore.checkRateLimit.bind(customStore);
  customStore.checkRateLimit = (...args) => { usedCustomStore = true; return originalCheckRateLimit(...args); };

  const worker = createAgentPaymentsWorker({
    assetsBinding: 'ASSETS',
    getStore: () => customStore,
  });
  // A browser (no agent key, no sec-fetch header but default UA is empty so
  // it's treated as non-browser) — use a request shaped like a browser
  // navigation to reach the challenge-issuance rate-limit check.
  const req = new Request('https://x.com/page', {
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
  });
  await worker.fetch(req, { ...ENV, ASSETS: { fetch: async () => new Response('ok') } }, {});
  assert.ok(usedCustomStore, 'custom getStore should have been used instead of the KV/in-memory default');
});

test('createNetlifyGate threads pricingTiers into the gate', async () => {
  globalThis.Deno = { env: { get: (k) => ENV[k] || '' } };
  try {
    const gate = createNetlifyGate({
      minPayment: 0.01,
      pricingTiers: [
        { minAmount: 0.01, durationSeconds: 3600, name: 'hourly' },
        { minAmount: 0.05, durationSeconds: null, name: 'lifetime' },
      ],
    });
    const req = new Request('https://x.com/data');
    const context = { ip: '1.2.3.4', next: async () => new Response('ok') };
    const resp = await gate(req, context);
    const body = await resp.json();
    // Floor price comes from the lowest tier, and the higher tier appears as
    // an extra x402 accepts[] entry.
    assert.equal(body.payment.amount, '0.01');
    assert.equal(body.accepts.length, 2);
  } finally {
    delete globalThis.Deno;
  }
});

test('createNetlifyGate accepts a custom store', async () => {
  globalThis.Deno = { env: { get: (k) => ENV[k] || '' } };
  try {
    let usedCustomStore = false;
    const customStore = new InMemoryStore();
    const original = customStore.getCachedPayment.bind(customStore);
    customStore.getCachedPayment = (...args) => { usedCustomStore = true; return original(...args); };

    mockNoAtaRpc();
    const gate = createNetlifyGate({ store: customStore });
    const key = await generateAgentKey(ENV.CHALLENGE_SECRET);
    const req = new Request('https://x.com/data', { headers: { 'x-agent-key': key } });
    const context = { ip: '1.2.3.4', next: async () => new Response('ok') };
    await gate(req, context);
    assert.ok(usedCustomStore, 'custom store should have been used');
  } finally {
    delete globalThis.Deno;
  }
});

test('createVercelEdgeGate threads accessDuration and a custom store into the gate', async () => {
  let usedCustomStore = false;
  const customStore = new InMemoryStore();
  const original = customStore.getCachedPayment.bind(customStore);
  customStore.getCachedPayment = (...args) => { usedCustomStore = true; return original(...args); };

  const gate = createVercelEdgeGate({
    minPayment: 0.01,
    accessDuration: 86400,
    env: ENV,
    upstreamNext: async () => new Response('ok'),
    store: customStore,
  });
  mockNoAtaRpc();
  const key = await generateAgentKey(ENV.CHALLENGE_SECRET);
  const req = new Request('https://x.com/data', { headers: { 'x-agent-key': key } });
  await gate(req);
  assert.ok(usedCustomStore, 'custom store should have been used');
});

test('createVercelEdgeGate throws without upstreamNext', () => {
  assert.throws(() => createVercelEdgeGate({}), /upstreamNext/);
});
