'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.PLATFORM_MASTER_SECRET = 'test-master-secret-do-not-use-in-prod';
process.env.DATA_FILE = path.join(__dirname, 'vendors.test.json');
// STRIPE_SECRET_KEY intentionally left unset — verifies the graceful no-op path.
delete process.env.STRIPE_SECRET_KEY;
delete process.env.SMTP_HOST;

const request = require('supertest');
const { app } = require('../server');

function resetStore() {
  fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({ vendors: {}, apiKeys: {}, verificationTokens: {} }, null, 2));
}

// The registration rate limiter (5/hour) is a single in-memory Map shared by the
// whole test process. Give each test its own fake IP via X-Forwarded-For so tests
// don't consume each other's limiter budget.
let ipCounter = 0;
function register(body) {
  ipCounter += 1;
  return request(app)
    .post('/v1/vendors/register')
    .set('X-Forwarded-For', `10.0.0.${ipCounter}`)
    .send(body);
}

test.after(() => {
  fs.rmSync(process.env.DATA_FILE, { force: true });
});

test('/v1/account returns platformFeeWallet: null when PLATFORM_FEE_WALLET is unset', async () => {
  resetStore();
  const reg = await register({ email: 'no-fee-vendor@test.com', name: 'No Fee Vendor' });
  const account = await request(app).get('/v1/account').set('Authorization', `Bearer ${reg.body.apiKey}`);
  assert.equal(account.status, 200);
  assert.equal(account.body.platformFeeWallet, null);
  assert.equal(account.body.platformFeeRatePct, null);
});

test('register -> issue key -> verify key -> usage flow (no Stripe, no email)', async () => {
  resetStore();

  const reg = await register({ email: 'vendor@test.com', name: 'Test Vendor' });
  assert.equal(reg.status, 201);
  assert.ok(reg.body.apiKey.startsWith('ap_live_'));
  assert.equal(reg.body.emailVerificationRequired, false);

  const issue = await request(app).post('/v1/keys/issue').set('Authorization', `Bearer ${reg.body.apiKey}`);
  assert.equal(issue.status, 200);
  assert.ok(issue.body.key.startsWith('agp_'));

  const verify = await request(app).post('/v1/keys/verify').send({ key: issue.body.key });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.valid, true);

  const usage = await request(app).get('/v1/usage').set('Authorization', `Bearer ${reg.body.apiKey}`);
  assert.equal(usage.status, 200);
  assert.equal(usage.body.keysIssuedAllTime, 1);
  assert.equal(usage.body.billing, null);
});

test('rejects unauthenticated /v1/keys/issue', async () => {
  resetStore();
  const res = await request(app).post('/v1/keys/issue');
  assert.equal(res.status, 401);
});

test('rejects a bad Authorization scheme on /v1/keys/issue', async () => {
  resetStore();
  const res = await request(app).post('/v1/keys/issue').set('Authorization', 'Basic dXNlcjpwYXNz');
  assert.equal(res.status, 401);
});

test('/v1/keys/verify rejects a forged/malformed key', async () => {
  resetStore();
  const malformed = await request(app).post('/v1/keys/verify').send({ key: 'not-a-real-key' });
  assert.equal(malformed.status, 400);

  const reg = await register({ email: 'forge@test.com', name: 'Forge Vendor' });
  const forged = await request(app).post('/v1/keys/verify').send({ key: `agp_${reg.body.vendorId}_deadbeef_0000000000000000` });
  assert.equal(forged.status, 200);
  assert.equal(forged.body.valid, false);
});

test('rejects duplicate email registration with 409', async () => {
  resetStore();
  await register({ email: 'dup@test.com', name: 'First' });
  const dup = await register({ email: 'dup@test.com', name: 'Second' });
  assert.equal(dup.status, 409);
});

test('rejects bad email/name on registration with 400', async () => {
  resetStore();
  const badEmail = await register({ email: 'not-an-email', name: 'Someone' });
  assert.equal(badEmail.status, 400);

  const badName = await register({ email: 'ok@test.com', name: 'x' });
  assert.equal(badName.status, 400);
});

test('dashboard login flow sets a session cookie and renders the dashboard', async () => {
  resetStore();
  const reg = await register({ email: 'dash@test.com', name: 'Dash Vendor' });

  const login = await request(app).post('/dashboard/login').type('form').send({ key: reg.body.apiKey });
  const setCookie = login.headers['set-cookie'];
  assert.ok(setCookie && setCookie.some((c) => c.startsWith('agp_dash=')));

  const cookie = setCookie.find((c) => c.startsWith('agp_dash=')).split(';')[0];
  const dash = await request(app).get('/dashboard').set('Cookie', cookie);
  assert.equal(dash.status, 200);
  assert.ok(dash.text.includes(reg.body.vendorId));
});

test('dashboard login rejects an invalid API key without setting a session cookie', async () => {
  resetStore();
  const login = await request(app).post('/dashboard/login').type('form').send({ key: 'ap_live_bogus' });
  assert.equal(login.status, 200);
  assert.ok(!login.headers['set-cookie']);
});

test('dashboard shows the on-chain fee section and a rotate-key link', async () => {
  resetStore();
  const reg = await register({ email: 'fee-dash@test.com', name: 'Fee Dash Vendor' });
  const login = await request(app).post('/dashboard/login').type('form').send({ key: reg.body.apiKey });
  const cookie = login.headers['set-cookie'].find((c) => c.startsWith('agp_dash=')).split(';')[0];

  const dash = await request(app).get('/dashboard').set('Cookie', cookie);
  assert.equal(dash.status, 200);
  assert.match(dash.text, /On-chain platform fee/);
  assert.match(dash.text, /Rotate API key/);
  assert.doesNotMatch(dash.text, /Billing period/); // stale Stripe section is gone
});

test('/dashboard/rotate-key requires a session', async () => {
  const res = await request(app).get('/dashboard/rotate-key');
  assert.equal(res.status, 200);
  assert.match(res.text, /Sign in/);
});

test('rotating the API key deactivates the old one and activates the new one', async () => {
  resetStore();
  const reg = await register({ email: 'rotate@test.com', name: 'Rotate Vendor' });
  const oldKey = reg.body.apiKey;

  const login = await request(app).post('/dashboard/login').type('form').send({ key: oldKey });
  const cookie = login.headers['set-cookie'].find((c) => c.startsWith('agp_dash=')).split(';')[0];

  const confirmPage = await request(app).get('/dashboard/rotate-key').set('Cookie', cookie);
  assert.equal(confirmPage.status, 200);
  assert.match(confirmPage.text, /Rotate now/);

  const rotate = await request(app).post('/dashboard/rotate-key').set('Cookie', cookie);
  assert.equal(rotate.status, 200);
  assert.match(rotate.text, /was rotated/);
  const newKeyMatch = rotate.text.match(/ap_live_[a-f0-9]+_[a-f0-9]+_[a-f0-9]+/);
  assert.ok(newKeyMatch, 'new key should appear in the reveal banner');
  const newKey = newKeyMatch[0];
  assert.notEqual(newKey, oldKey);

  // The old key is now dead...
  const oldFails = await request(app).post('/v1/keys/issue').set('Authorization', `Bearer ${oldKey}`);
  assert.equal(oldFails.status, 401);

  // ...and the new one works.
  const newWorks = await request(app).post('/v1/keys/issue').set('Authorization', `Bearer ${newKey}`);
  assert.equal(newWorks.status, 200);

  // The dashboard session itself (vendor-id based, not tied to the old key) still works.
  const stillLoggedIn = await request(app).get('/dashboard').set('Cookie', cookie);
  assert.equal(stillLoggedIn.status, 200);
  assert.match(stillLoggedIn.text, /Rotate Vendor/);
});

test('stripe-billing module no-ops all functions when STRIPE_SECRET_KEY is unset', async () => {
  const { createCustomerAndSubscription, recordKeyIssuance, getCurrentUsage } = require('../stripe-billing');
  assert.equal(await createCustomerAndSubscription('a@b.com', 'x'), null);
  await assert.doesNotReject(recordKeyIssuance('cus_123'));
  assert.equal(await getCurrentUsage('cus_123'), null);
});

// ---------------------------------------------------------------------------
// Domain ownership verification
// ---------------------------------------------------------------------------

test('POST /v1/domains rejects an invalid domain and requires auth', async () => {
  resetStore();
  const reg = await register({ email: 'domains1@test.com', name: 'Domains Vendor' });
  const auth = `Bearer ${reg.body.apiKey}`;

  const noAuth = await request(app).post('/v1/domains').send({ domain: 'example.com' });
  assert.equal(noAuth.status, 401);

  const badFormat = await request(app).post('/v1/domains').set('Authorization', auth).send({ domain: 'https://example.com/path' });
  assert.equal(badFormat.status, 400);

  const internal = await request(app).post('/v1/domains').set('Authorization', auth).send({ domain: 'service.internal' });
  assert.equal(internal.status, 400);
});

test('POST /v1/domains -> GET /v1/domains -> DELETE round trip, with duplicate rejection', async () => {
  resetStore();
  const reg = await register({ email: 'domains2@test.com', name: 'Domains Vendor 2' });
  const auth = `Bearer ${reg.body.apiKey}`;

  const created = await request(app).post('/v1/domains').set('Authorization', auth).send({ domain: 'Example.com' });
  assert.equal(created.status, 201);
  assert.equal(created.body.domain, 'example.com'); // normalized lowercase
  assert.equal(created.body.verified, false);
  assert.ok(created.body.verificationToken);
  assert.equal(created.body.verifyUrl, 'https://example.com/.well-known/agentpayments-verify.txt');

  const dup = await request(app).post('/v1/domains').set('Authorization', auth).send({ domain: 'example.com' });
  assert.equal(dup.status, 409);

  const list = await request(app).get('/v1/domains').set('Authorization', auth);
  assert.equal(list.status, 200);
  assert.equal(list.body.domains.length, 1);
  assert.equal(list.body.domains[0].id, created.body.id);

  const del = await request(app).delete(`/v1/domains/${created.body.id}`).set('Authorization', auth);
  assert.equal(del.status, 204);

  const listAfter = await request(app).get('/v1/domains').set('Authorization', auth);
  assert.equal(listAfter.body.domains.length, 0);

  const delAgain = await request(app).delete(`/v1/domains/${created.body.id}`).set('Authorization', auth);
  assert.equal(delAgain.status, 404);
});

test('domain endpoints are scoped per-vendor — one vendor cannot see or delete another\'s domain', async () => {
  resetStore();
  const regA = await register({ email: 'vendorA@test.com', name: 'Vendor A' });
  const regB = await register({ email: 'vendorB@test.com', name: 'Vendor B' });
  const authA = `Bearer ${regA.body.apiKey}`;
  const authB = `Bearer ${regB.body.apiKey}`;

  const created = await request(app).post('/v1/domains').set('Authorization', authA).send({ domain: 'vendor-a-site.com' });
  assert.equal(created.status, 201);

  const listB = await request(app).get('/v1/domains').set('Authorization', authB);
  assert.equal(listB.body.domains.length, 0);

  const verifyB = await request(app).post(`/v1/domains/${created.body.id}/verify`).set('Authorization', authB);
  assert.equal(verifyB.status, 404);

  const delB = await request(app).delete(`/v1/domains/${created.body.id}`).set('Authorization', authB);
  assert.equal(delB.status, 404);
});

test('POST /v1/domains/:id/verify against a real domain with no verification file fails with a clear reason', async () => {
  resetStore();
  const reg = await register({ email: 'domains3@test.com', name: 'Domains Vendor 3' });
  const auth = `Bearer ${reg.body.apiKey}`;

  const created = await request(app).post('/v1/domains').set('Authorization', auth).send({ domain: 'example.com' });
  assert.equal(created.status, 201);

  // Live network call against example.com (RFC 2606 reserved, stable, always resolves) —
  // it has no /.well-known/agentpayments-verify.txt, so this exercises the real
  // token-mismatch/404 failure path end to end.
  const verify = await request(app).post(`/v1/domains/${created.body.id}/verify`).set('Authorization', auth);
  assert.equal(verify.status, 422);
  assert.equal(verify.body.error, 'verification_failed');
});

test('dashboard: add domain, see it listed, remove it', async () => {
  resetStore();
  const reg = await register({ email: 'dashdomains@test.com', name: 'Dash Domains Vendor' });
  const login = await request(app).post('/dashboard/login').type('form').send({ key: reg.body.apiKey });
  const cookie = login.headers['set-cookie'].find((c) => c.startsWith('agp_dash=')).split(';')[0];

  const add = await request(app).post('/dashboard/domains').set('Cookie', cookie).type('form').send({ domain: 'my-dash-site.com' });
  assert.equal(add.status, 302);
  assert.equal(add.headers.location, '/dashboard');

  const page = await request(app).get('/dashboard').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /my-dash-site\.com/);
  assert.match(page.text, /Unverified/);

  const list = await request(app).get('/v1/domains').set('Authorization', `Bearer ${reg.body.apiKey}`);
  const domainId = list.body.domains[0].id;

  const remove = await request(app).post(`/dashboard/domains/${domainId}/delete`).set('Cookie', cookie);
  assert.equal(remove.status, 302);

  const pageAfter = await request(app).get('/dashboard').set('Cookie', cookie);
  assert.doesNotMatch(pageAfter.text, /my-dash-site\.com/);
});

test('dashboard: adding an invalid domain redirects with domainError shown on the page', async () => {
  resetStore();
  const reg = await register({ email: 'dashbad@test.com', name: 'Dash Bad Vendor' });
  const login = await request(app).post('/dashboard/login').type('form').send({ key: reg.body.apiKey });
  const cookie = login.headers['set-cookie'].find((c) => c.startsWith('agp_dash=')).split(';')[0];

  const add = await request(app).post('/dashboard/domains').set('Cookie', cookie).type('form').send({ domain: 'not a domain' });
  assert.equal(add.status, 302);
  assert.match(add.headers.location, /^\/dashboard\?domainError=/);

  const page = await request(app).get(add.headers.location).set('Cookie', cookie);
  assert.match(page.text, /Enter a valid domain/);
});
