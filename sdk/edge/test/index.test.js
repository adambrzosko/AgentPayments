import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  hmacSign, generateAgentKey, isValidAgentKey,
  isPublicPath, isBrowser, getCookie, isValidCookie,
  challengePage, jsonResponse, clientIdForIp, verifyPaymentOnChain,
  createEdgeGate, InMemoryStore,
} from '../index.js';

const SECRET = 'test-secret-edge';

test('hmacSign returns deterministic hex', async () => {
  const a = await hmacSign('hello', SECRET);
  const b = await hmacSign('hello', SECRET);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(await hmacSign('hello', 'other'), a);
});

test('generateAgentKey produces valid format', async () => {
  const key = await generateAgentKey(SECRET);
  assert.match(key, /^ag_[0-9a-f]{16}_[0-9a-f]{16}$/);
});

test('isValidAgentKey roundtrip', async () => {
  const key = await generateAgentKey(SECRET);
  assert.equal(await isValidAgentKey(key, SECRET), true);
});

test('isValidAgentKey rejects tampered key', async () => {
  const key = await generateAgentKey(SECRET);
  const tampered = key.slice(0, -1) + (key.at(-1) === '0' ? '1' : '0');
  assert.equal(await isValidAgentKey(tampered, SECRET), false);
});

test('isValidAgentKey rejects wrong secret', async () => {
  const key = await generateAgentKey(SECRET);
  assert.equal(await isValidAgentKey(key, 'wrong'), false);
});

test('isValidAgentKey rejects empty/null/long', async () => {
  assert.equal(await isValidAgentKey('', SECRET), false);
  assert.equal(await isValidAgentKey(null, SECRET), false);
  assert.equal(await isValidAgentKey('a'.repeat(200), SECRET), false);
});

test('isPublicPath with default and custom allowlist', () => {
  assert.equal(isPublicPath('/robots.txt'), true);
  assert.equal(isPublicPath('/.well-known/foo'), true);
  assert.equal(isPublicPath('/api/data'), false);
  assert.equal(isPublicPath('/custom', ['/custom']), true);
  assert.equal(isPublicPath('/other', ['/custom']), false);
});

test('isBrowser detects sec-fetch headers on Request objects', () => {
  const browser = new Request('https://x.com', { headers: { 'sec-fetch-mode': 'navigate' } });
  assert.equal(isBrowser(browser), true);
  const agent = new Request('https://x.com', { headers: { 'user-agent': 'bot/1' } });
  assert.equal(isBrowser(agent), false);
});

test('isBrowser treats real browser navigation as browser', () => {
  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const nav = new Request('https://x.com', {
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'user-agent': chromeUA },
  });
  assert.equal(isBrowser(nav), true);
});

test('isBrowser does not misclassify fetch()-shaped agent requests as browsers', () => {
  // Node's built-in fetch() (undici) always sends sec-fetch-mode: cors but never
  // sets Sec-Fetch-Dest. Combined with a non-browser UA this must not pass as a browser.
  const agentFetch = new Request('https://x.com', {
    headers: { 'sec-fetch-mode': 'cors', 'user-agent': 'my-agent/1.0' },
  });
  assert.equal(isBrowser(agentFetch), false);
});

test('getCookie parses from Web Request', () => {
  const req = new Request('https://x.com', { headers: { cookie: 'a=1; __agp_verified=abc; b=2' } });
  assert.equal(getCookie(req, '__agp_verified'), 'abc');
  assert.equal(getCookie(req, 'a'), '1');
  assert.equal(getCookie(req, 'missing'), null);
});

test('isValidCookie roundtrip', async () => {
  const clientIp = '1.2.3.4';
  const now = Date.now().toString();
  const clientId = await clientIdForIp(clientIp, SECRET);
  const sig = await hmacSign(`cookie:${now}:${clientId}`, SECRET);
  const req = new Request('https://x.com', { headers: { cookie: `__agp_verified=${now}.${sig}` } });
  assert.equal(await isValidCookie(req, SECRET, clientIp), true);
});

test('isValidCookie rejects missing cookie', async () => {
  const req = new Request('https://x.com');
  assert.equal(await isValidCookie(req, SECRET, '1.2.3.4'), false);
});

test('challengePage returns Response with HTML', async () => {
  const resp = challengePage('/test', '123.abc');
  assert.ok(resp instanceof Response);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('content-type'), 'text/html');
  const html = await resp.text();
  assert.ok(html.includes('<!DOCTYPE html'));
  assert.ok(html.includes('123.abc'));
  assert.ok(html.includes('/test'));
});

test('jsonResponse returns correct status and content-type', async () => {
  const resp = jsonResponse({ error: 'test' }, 402);
  assert.equal(resp.status, 402);
  assert.equal(resp.headers.get('content-type'), 'application/json');
  const body = await resp.json();
  assert.equal(body.error, 'test');
});

// ─── verifyPaymentOnChain: RPC mocking via global.fetch ────────────────────
const WALLET = '5rXZeAEbg13DQnSFijEno2hKEJLK2p14fAo3AmPtfBft';
const FEE_WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // devnet USDC
const RPC = 'https://api.devnet.solana.com';
const MIN_PAYMENT = 0.01;
const FEE_INFO = { wallet: FEE_WALLET, ratePct: 2 };
const FEE_AMOUNT = MIN_PAYMENT * 0.02;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function feeTestAta(pubkey) {
  return { value: [{ pubkey, account: { data: { parsed: { info: { mint: MINT } } } } }] };
}

function buildFeeTestTx(memo, amount, { feeAmount, preVendorBalance = 0, preFeeBalance = 0 } = {}) {
  const accountKeys = [
    { pubkey: 'payer_address' }, { pubkey: 'agent_ata_address' }, { pubkey: 'dest_ata_address' },
    ...(feeAmount !== undefined ? [{ pubkey: 'fee_ata_address' }] : []),
  ];
  const instructions = [{
    program: 'spl-token',
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    parsed: { type: 'transferChecked', info: { mint: MINT, tokenAmount: { amount: String(Math.round(amount * 1e6)) }, destination: 'dest_ata_address' } },
  }];
  const preTokenBalances = preVendorBalance > 0 ? [{ accountIndex: 2, mint: MINT, uiTokenAmount: { amount: String(Math.round(preVendorBalance * 1e6)) } }] : [];
  const postTokenBalances = [{ accountIndex: 2, mint: MINT, uiTokenAmount: { amount: String(Math.round((preVendorBalance + amount) * 1e6)) } }];
  if (feeAmount !== undefined) {
    instructions.push({
      program: 'spl-token',
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      parsed: { type: 'transferChecked', info: { mint: MINT, tokenAmount: { amount: String(Math.round(feeAmount * 1e6)) }, destination: 'fee_ata_address' } },
    });
    if (preFeeBalance > 0) preTokenBalances.push({ accountIndex: 3, mint: MINT, uiTokenAmount: { amount: String(Math.round(preFeeBalance * 1e6)) } });
    postTokenBalances.push({ accountIndex: 3, mint: MINT, uiTokenAmount: { amount: String(Math.round((preFeeBalance + feeAmount) * 1e6)) } });
  }
  instructions.push({ program: 'spl-memo', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: memo });
  return { meta: { err: null, innerInstructions: [], preTokenBalances, postTokenBalances }, transaction: { message: { instructions, accountKeys } } };
}

// Dispatches RPC calls by method (and, for getTokenAccountsByOwner, by which
// owner address is being queried — vendor wallet vs fee wallet get different
// ATA sets when both are queried in one verify call).
function mockFeeRpc({ sigs, ata: vendorAta, feeAta, tx }) {
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    let result = null;
    if (body.method === 'getTokenAccountsByOwner') {
      const owner = body.params[0];
      result = (feeAta !== undefined && owner === FEE_WALLET) ? feeAta : vendorAta;
    } else if (body.method === 'getSignaturesForAddress') {
      result = sigs;
    } else if (body.method === 'getTransaction') {
      result = tx;
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
}

test('verifyPaymentOnChain: vendor leg alone passes when no fee is required', async () => {
  const key = 'agp_test_key';
  mockFeeRpc({ sigs: [{ signature: 'sig1', err: null }], ata: feeTestAta('dest_ata_address'), tx: buildFeeTestTx(key, MIN_PAYMENT) });
  const result = await verifyPaymentOnChain(key, WALLET, [RPC], MINT, MIN_PAYMENT, null);
  assert.equal(result, true);
});

test('verifyPaymentOnChain: fee leg missing denies access when fee is required', async () => {
  const key = 'agp_test_key_2';
  mockFeeRpc({ sigs: [{ signature: 'sig2', err: null }], ata: feeTestAta('dest_ata_address'), feeAta: feeTestAta('fee_ata_address'), tx: buildFeeTestTx(key, MIN_PAYMENT) });
  const result = await verifyPaymentOnChain(key, WALLET, [RPC], MINT, MIN_PAYMENT, FEE_INFO);
  assert.equal(result, false);
});

test('verifyPaymentOnChain: both legs in the same transaction grants access', async () => {
  const key = 'agp_test_key_3';
  mockFeeRpc({
    sigs: [{ signature: 'sig3', err: null }],
    ata: feeTestAta('dest_ata_address'),
    feeAta: feeTestAta('fee_ata_address'),
    tx: buildFeeTestTx(key, MIN_PAYMENT, { feeAmount: FEE_AMOUNT }),
  });
  const result = await verifyPaymentOnChain(key, WALLET, [RPC], MINT, MIN_PAYMENT, FEE_INFO);
  assert.equal(result, true);
});

test('verifyPaymentOnChain: underpaid fee leg denies access', async () => {
  const key = 'agp_test_key_4';
  mockFeeRpc({
    sigs: [{ signature: 'sig4', err: null }],
    ata: feeTestAta('dest_ata_address'),
    feeAta: feeTestAta('fee_ata_address'),
    tx: buildFeeTestTx(key, MIN_PAYMENT, { feeAmount: FEE_AMOUNT / 2 }),
  });
  const result = await verifyPaymentOnChain(key, WALLET, [RPC], MINT, MIN_PAYMENT, FEE_INFO);
  assert.equal(result, false);
});

test('verifyPaymentOnChain: fee wallet with no USDC account denies access', async () => {
  const key = 'agp_test_key_5';
  mockFeeRpc({
    sigs: [{ signature: 'sig5', err: null }],
    ata: feeTestAta('dest_ata_address'),
    feeAta: { value: [] },
    tx: buildFeeTestTx(key, MIN_PAYMENT, { feeAmount: FEE_AMOUNT }),
  });
  const result = await verifyPaymentOnChain(key, WALLET, [RPC], MINT, MIN_PAYMENT, FEE_INFO);
  assert.equal(result, false);
});

// ─── balance-delta verification (replaces instruction parsing) ────────────

test('verifyPaymentOnChain: payment recognized when the vendor ATA is created in the same transaction', async () => {
  const key = 'agp_test_key_new_ata';
  mockFeeRpc({ sigs: [{ signature: 'sig_new_ata', err: null }], ata: feeTestAta('dest_ata_address'), tx: buildFeeTestTx(key, MIN_PAYMENT) });
  const result = await verifyPaymentOnChain(key, WALLET, [RPC], MINT, MIN_PAYMENT, null);
  assert.equal(result, true);
});

test('verifyPaymentOnChain: payment recognized against a pre-existing non-zero vendor balance', async () => {
  const key = 'agp_test_key_existing_balance';
  mockFeeRpc({
    sigs: [{ signature: 'sig_existing_balance', err: null }],
    ata: feeTestAta('dest_ata_address'),
    tx: buildFeeTestTx(key, MIN_PAYMENT, { preVendorBalance: 5 }),
  });
  const result = await verifyPaymentOnChain(key, WALLET, [RPC], MINT, MIN_PAYMENT, null);
  assert.equal(result, true);
});

test('verifyPaymentOnChain: payment recognized from balance delta alone, with no matching transfer instruction', async () => {
  const key = 'agp_test_key_no_ix';
  const tx = {
    meta: {
      err: null,
      innerInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 1, mint: MINT, uiTokenAmount: { amount: String(Math.round(MIN_PAYMENT * 1e6)) } }],
    },
    transaction: { message: {
      instructions: [{ program: 'spl-memo', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: key }],
      accountKeys: [{ pubkey: 'payer_address' }, { pubkey: 'dest_ata_address' }],
    } },
  };
  mockFeeRpc({ sigs: [{ signature: 'sig_no_ix', err: null }], ata: feeTestAta('dest_ata_address'), tx });
  const result = await verifyPaymentOnChain(key, WALLET, [RPC], MINT, MIN_PAYMENT, null);
  assert.equal(result, true);
});

test('verifyPaymentOnChain: a net-negative balance change is not treated as payment', async () => {
  const key = 'agp_test_key_negative_delta';
  const tx = {
    meta: {
      err: null,
      innerInstructions: [],
      preTokenBalances: [{ accountIndex: 1, mint: MINT, uiTokenAmount: { amount: String(Math.round(10 * 1e6)) } }],
      postTokenBalances: [{ accountIndex: 1, mint: MINT, uiTokenAmount: { amount: String(Math.round(9 * 1e6)) } }],
    },
    transaction: { message: {
      instructions: [{ program: 'spl-memo', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: key }],
      accountKeys: [{ pubkey: 'payer_address' }, { pubkey: 'dest_ata_address' }],
    } },
  };
  mockFeeRpc({ sigs: [{ signature: 'sig_negative_delta', err: null }], ata: feeTestAta('dest_ata_address'), tx });
  const result = await verifyPaymentOnChain(key, WALLET, [RPC], MINT, MIN_PAYMENT, null);
  assert.equal(result, false);
});

test('verifyPaymentOnChain: deltas across multiple vendor ATAs sum to satisfy the threshold', async () => {
  const key = 'agp_test_key_multi_ata';
  const half = MIN_PAYMENT / 2;
  const tx = {
    meta: {
      err: null,
      innerInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 1, mint: MINT, uiTokenAmount: { amount: String(Math.round(half * 1e6)) } },
        { accountIndex: 2, mint: MINT, uiTokenAmount: { amount: String(Math.round(half * 1e6)) } },
      ],
    },
    transaction: { message: {
      instructions: [{ program: 'spl-memo', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: key }],
      accountKeys: [{ pubkey: 'payer_address' }, { pubkey: 'dest_ata_one' }, { pubkey: 'dest_ata_two' }],
    } },
  };
  mockFeeRpc({
    sigs: [{ signature: 'sig_multi_ata', err: null }],
    ata: { value: [{ pubkey: 'dest_ata_one', account: { data: { parsed: { info: { mint: MINT } } } } }, { pubkey: 'dest_ata_two', account: { data: { parsed: { info: { mint: MINT } } } } }] },
    tx,
  });
  const result = await verifyPaymentOnChain(key, WALLET, [RPC], MINT, MIN_PAYMENT, null);
  assert.equal(result, true);
});

// ─── InMemoryStore: revocation ─────────────────────────────────────────────
test('InMemoryStore.invalidatePayment clears a cached positive result', async () => {
  const store = new InMemoryStore();
  await store.setCachedPayment('ag_cached_key', true, 100000);
  assert.equal(await store.getCachedPayment('ag_cached_key'), true);
  await store.invalidatePayment('ag_cached_key');
  assert.equal(await store.getCachedPayment('ag_cached_key'), undefined);
});

// ─── Pricing & access model (createEdgeGate) ───────────────────────────────
function makeSpyStore() {
  const inner = new InMemoryStore();
  const setCachedPaymentCalls = [];
  return {
    consumeNonce: (...a) => inner.consumeNonce(...a),
    checkRateLimit: (...a) => inner.checkRateLimit(...a),
    getCachedPayment: (...a) => inner.getCachedPayment(...a),
    setCachedPayment: (...a) => { setCachedPaymentCalls.push(a); return inner.setCachedPayment(...a); },
    invalidatePayment: (...a) => inner.invalidatePayment(...a),
    setCachedPaymentCalls,
  };
}

const GATE_WALLET = '5rXZeAEbg13DQnSFijEno2hKEJLK2p14fAo3AmPtfBft';
const GATE_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const GATE_RPC = 'https://api.devnet.solana.com';

function gateAta(pubkey) {
  return { value: [{ pubkey, account: { data: { parsed: { info: { mint: GATE_MINT } } } } }] };
}
function gateTx(memo, amount) {
  const accountKeys = [{ pubkey: 'payer_address' }, { pubkey: 'agent_ata_address' }, { pubkey: 'dest_ata_address' }];
  return {
    meta: {
      err: null,
      innerInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 2, mint: GATE_MINT, uiTokenAmount: { amount: String(Math.round(amount * 1e6)) } }],
    },
    transaction: { message: {
      instructions: [
        { program: 'spl-token', programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', parsed: { type: 'transferChecked', info: { mint: GATE_MINT, tokenAmount: { amount: String(Math.round(amount * 1e6)) }, destination: 'dest_ata_address' } } },
        { program: 'spl-memo', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: memo },
      ],
      accountKeys,
    } },
  };
}
function mockGateRpc(key, amountPaid) {
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    let result = null;
    if (body.method === 'getTokenAccountsByOwner') result = gateAta('dest_ata_address');
    else if (body.method === 'getSignaturesForAddress') result = [{ signature: 'sig1', err: null }];
    else if (body.method === 'getTransaction') result = gateTx(key, amountPaid);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
}

test('accessDuration overrides the default 10-minute cache TTL', async () => {
  const key = await generateAgentKey(SECRET);
  mockGateRpc(key, 0.01);
  const spyStore = makeSpyStore();
  const gate = createEdgeGate({
    fetchUpstream: async () => new Response('ok'),
    minPayment: 0.01,
    accessDuration: 86400,
    store: spyStore,
  });
  const req = new Request('https://x.com/data', { headers: { 'x-agent-key': key } });
  const env = { CHALLENGE_SECRET: SECRET, HOME_WALLET_ADDRESS: GATE_WALLET, DEBUG: 'true', SOLANA_RPC_URL: GATE_RPC, USDC_MINT: GATE_MINT };
  const res = await gate(req, env);
  assert.equal(res.status, 200);
  assert.equal(spyStore.setCachedPaymentCalls.length, 1);
  assert.equal(spyStore.setCachedPaymentCalls[0][2], 86400 * 1000);
});

test('routes overrides minPayment for a matching path prefix', async () => {
  const gate = createEdgeGate({
    fetchUpstream: async () => new Response('ok'),
    minPayment: 0.01,
    routes: [{ pathPrefix: '/premium', minPayment: 0.05 }],
  });
  const env = { CHALLENGE_SECRET: SECRET, HOME_WALLET_ADDRESS: GATE_WALLET, DEBUG: 'true', SOLANA_RPC_URL: GATE_RPC, USDC_MINT: GATE_MINT };

  const premiumReq = new Request('https://x.com/premium/data');
  const premiumRes = await gate(premiumReq, env);
  const premiumBody = await premiumRes.json();
  assert.equal(premiumBody.payment.amount, '0.05');

  const otherReq = new Request('https://x.com/other');
  const otherRes = await gate(otherReq, env);
  const otherBody = await otherRes.json();
  assert.equal(otherBody.payment.amount, '0.01');
});
