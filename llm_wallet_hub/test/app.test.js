import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.MASTER_KEY = '0123456789012345678901234567890123456789';
process.env.PAYMENTS_DRY_RUN = 'true';

const { default: app } = await import('../app.js');

const DB_PATH = path.join(process.cwd(), 'data', 'db.json');

function resetDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify({ users: [], apiKeys: [], payments: [] }, null, 2));
}

test('signup + login flow', async () => {
  resetDb();
  const signup = await request(app).post('/api/signup').send({ email: 'a@test.com', password: 'verystrongpass' });
  assert.equal(signup.status, 200);
  assert.ok(signup.body.sessionToken);

  const me = await request(app).get('/api/me').set('x-session-token', signup.body.sessionToken);
  assert.equal(me.status, 200);
  assert.equal(me.body.email, 'a@test.com');

  const login = await request(app).post('/api/login').send({ email: 'a@test.com', password: 'verystrongpass' });
  assert.equal(login.status, 200);
  assert.ok(login.body.sessionToken);
});

test('tool pay enforces per-payment cap', async () => {
  resetDb();
  const signup = await request(app).post('/api/signup').send({ email: 'b@test.com', password: 'verystrongpass' });
  const sessionToken = signup.body.sessionToken;

  const key = await request(app)
    .post('/api/keys')
    .set('x-session-token', sessionToken)
    .send({ maxSolPerPayment: 0.01, dailySolCap: 0.1 });
  assert.equal(key.status, 200);

  const pay = await request(app)
    .post('/api/tool/pay')
    .set('x-wallet-tool-key', key.body.rawKey)
    .send({
      recipient: signup.body.user.walletAddress,
      amountSol: 0.02,
      reason: 'test',
      resourceUrl: 'https://example.com'
    });

  assert.equal(pay.status, 403);
  assert.match(pay.body.error, /per-payment limit/);
});

test('idempotency key replays same payment', async () => {
  resetDb();
  const signup = await request(app).post('/api/signup').send({ email: 'c@test.com', password: 'verystrongpass' });
  const sessionToken = signup.body.sessionToken;

  const key = await request(app)
    .post('/api/keys')
    .set('x-session-token', sessionToken)
    .send({ maxSolPerPayment: 0.05, dailySolCap: 0.2, allowlistedRecipients: [signup.body.user.walletAddress] });

  const idem = '11111111-1111-1111-1111-111111111111';
  const payload = { recipient: signup.body.user.walletAddress, amountSol: 0.01, reason: 't', resourceUrl: 'u' };

  const first = await request(app).post('/api/tool/pay').set('x-wallet-tool-key', key.body.rawKey).set('x-idempotency-key', idem).send(payload);
  assert.equal(first.status, 200);

  const second = await request(app).post('/api/tool/pay').set('x-wallet-tool-key', key.body.rawKey).set('x-idempotency-key', idem).send(payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.replay, true);
  assert.equal(second.body.signature, first.body.signature);
});
