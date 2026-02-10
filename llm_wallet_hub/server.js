import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import { fileURLToPath } from 'url';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8787;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const MASTER_KEY = process.env.MASTER_KEY || 'dev-only-change-me-dev-only-change-me';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: [], apiKeys: [], payments: [] }, null, 2));
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, encoded) {
  const [salt, hash] = encoded.split(':');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
}

function deriveKey() {
  return crypto.createHash('sha256').update(MASTER_KEY).digest();
}

function encryptSecret(secretBase58) {
  const iv = crypto.randomBytes(12);
  const key = deriveKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secretBase58, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex')
  };
}

function decryptSecret(enc) {
  const key = deriveKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(enc.data, 'hex')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

function issueToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function authUser(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token) return res.status(401).json({ error: 'Missing session token' });
  const db = readDb();
  const user = db.users.find((u) => u.sessionToken === token);
  if (!user) return res.status(401).json({ error: 'Invalid session token' });
  req.user = user;
  req.db = db;
  next();
}

function authTool(req, res, next) {
  const key = req.headers['x-wallet-tool-key'];
  if (!key) return res.status(401).json({ error: 'Missing wallet tool key' });
  const db = readDb();
  const apiKey = db.apiKeys.find((k) => k.key === key && k.active);
  if (!apiKey) return res.status(401).json({ error: 'Invalid wallet tool key' });
  const user = db.users.find((u) => u.id === apiKey.userId);
  if (!user) return res.status(401).json({ error: 'Key owner missing' });
  req.user = user;
  req.apiKey = apiKey;
  req.db = db;
  next();
}

function getPolicy(user, apiKey) {
  return {
    maxSolPerPayment: apiKey.maxSolPerPayment ?? user.policy.maxSolPerPayment,
    dailySolCap: apiKey.dailySolCap ?? user.policy.dailySolCap,
    allowlistedRecipients: apiKey.allowlistedRecipients?.length
      ? apiKey.allowlistedRecipients
      : user.policy.allowlistedRecipients
  };
}

async function getBalanceSol(publicKeyString) {
  const lamports = await connection.getBalance(new PublicKey(publicKeyString));
  return lamports / LAMPORTS_PER_SOL;
}

async function transferSol(fromSecretBase58, toAddress, amountSol) {
  const fromKeypair = Keypair.fromSecretKey(bs58.decode(fromSecretBase58));
  const toPubkey = new PublicKey(toAddress);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey,
      lamports
    })
  );

  const signature = await connection.sendTransaction(tx, [fromKeypair]);
  await connection.confirmTransaction(signature, 'confirmed');
  return signature;
}

app.post('/api/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: 'Email + password (min 8 chars) required' });
    }

    const db = readDb();
    if (db.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
      return res.status(409).json({ error: 'Email already exists' });
    }

    const kp = Keypair.generate();
    const secret58 = bs58.encode(kp.secretKey);
    const user = {
      id: crypto.randomUUID(),
      email,
      passwordHash: hashPassword(password),
      wallet: {
        publicKey: kp.publicKey.toBase58(),
        encryptedSecret: encryptSecret(secret58)
      },
      policy: {
        maxSolPerPayment: 0.05,
        dailySolCap: 0.2,
        allowlistedRecipients: []
      },
      sessionToken: issueToken(24),
      createdAt: new Date().toISOString()
    };

    db.users.push(user);
    writeDb(db);

    res.json({
      sessionToken: user.sessionToken,
      user: {
        id: user.id,
        email: user.email,
        walletAddress: user.wallet.publicKey,
        policy: user.policy
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const db = readDb();
  const user = db.users.find((u) => u.email.toLowerCase() === String(email || '').toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!verifyPassword(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  user.sessionToken = issueToken(24);
  writeDb(db);
  res.json({
    sessionToken: user.sessionToken,
    user: {
      id: user.id,
      email: user.email,
      walletAddress: user.wallet.publicKey,
      policy: user.policy
    }
  });
});

app.get('/api/me', authUser, async (req, res) => {
  const balanceSol = await getBalanceSol(req.user.wallet.publicKey);
  res.json({
    id: req.user.id,
    email: req.user.email,
    walletAddress: req.user.wallet.publicKey,
    balanceSol,
    policy: req.user.policy
  });
});

app.post('/api/keys', authUser, (req, res) => {
  const { name = 'default', maxSolPerPayment, dailySolCap, allowlistedRecipients = [] } = req.body;
  const keyValue = `ak_${issueToken(20)}`;
  const newKey = {
    id: crypto.randomUUID(),
    userId: req.user.id,
    name,
    key: keyValue,
    active: true,
    maxSolPerPayment: maxSolPerPayment != null ? Number(maxSolPerPayment) : null,
    dailySolCap: dailySolCap != null ? Number(dailySolCap) : null,
    allowlistedRecipients: Array.isArray(allowlistedRecipients) ? allowlistedRecipients : [],
    createdAt: new Date().toISOString()
  };
  req.db.apiKeys.push(newKey);
  writeDb(req.db);
  res.json(newKey);
});

app.get('/api/keys', authUser, (req, res) => {
  const keys = req.db.apiKeys
    .filter((k) => k.userId === req.user.id)
    .map((k) => ({ ...k, key: `${k.key.slice(0, 8)}...` }));
  res.json(keys);
});

app.post('/api/policy', authUser, (req, res) => {
  const { maxSolPerPayment, dailySolCap, allowlistedRecipients } = req.body;
  if (maxSolPerPayment != null) req.user.policy.maxSolPerPayment = Number(maxSolPerPayment);
  if (dailySolCap != null) req.user.policy.dailySolCap = Number(dailySolCap);
  if (Array.isArray(allowlistedRecipients)) req.user.policy.allowlistedRecipients = allowlistedRecipients;
  writeDb(req.db);
  res.json(req.user.policy);
});

app.get('/api/system-prompt', authUser, (req, res) => {
  const { model = 'gpt' } = req.query;
  const prompt = `You can use a wallet payment tool for paywalled websites.\n\nRULES:\n1) Before paying, request a quote/challenge from the website.\n2) Only pay if content is required for the user task.\n3) Never exceed policy limits.\n4) Explain briefly why payment is needed.\n\nTool name: wallet_pay\nTool input JSON:\n{\n  "recipient": "<solana address>",\n  "amountSol": 0.01,\n  "reason": "<why needed>",\n  "resourceUrl": "https://example.com/article"\n}\n\nTool endpoint:\nPOST ${APP_BASE_URL}/api/tool/pay\nHeader: x-wallet-tool-key: <USER_TOOL_KEY>\n\nAfter payment, use returned signature as proof.`;

  res.json({
    model,
    prompt,
    toolSchema: {
      name: 'wallet_pay',
      input: {
        recipient: 'string',
        amountSol: 'number',
        reason: 'string',
        resourceUrl: 'string'
      }
    }
  });
});

app.post('/api/tool/pay', authTool, async (req, res) => {
  try {
    const { recipient, amountSol, reason = '', resourceUrl = '' } = req.body;
    if (!recipient || !amountSol) {
      return res.status(400).json({ error: 'recipient and amountSol required' });
    }

    const amount = Number(amountSol);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amountSol' });
    }

    const policy = getPolicy(req.user, req.apiKey);

    if (amount > policy.maxSolPerPayment) {
      return res.status(403).json({
        error: `amount exceeds per-payment limit (${policy.maxSolPerPayment} SOL)`
      });
    }

    if (policy.allowlistedRecipients.length > 0 && !policy.allowlistedRecipients.includes(recipient)) {
      return res.status(403).json({ error: 'recipient not in allowlist' });
    }

    const since = Date.now() - 24 * 3600 * 1000;
    const paidToday = req.db.payments
      .filter((p) => p.userId === req.user.id)
      .filter((p) => new Date(p.createdAt).getTime() >= since)
      .reduce((sum, p) => sum + p.amountSol, 0);

    if (paidToday + amount > policy.dailySolCap) {
      return res.status(403).json({ error: 'daily cap exceeded' });
    }

    const secret58 = decryptSecret(req.user.wallet.encryptedSecret);
    const signature = await transferSol(secret58, recipient, amount);

    const payment = {
      id: crypto.randomUUID(),
      userId: req.user.id,
      apiKeyId: req.apiKey.id,
      recipient,
      amountSol: amount,
      reason,
      resourceUrl,
      signature,
      createdAt: new Date().toISOString()
    };
    req.db.payments.push(payment);
    writeDb(req.db);

    res.json({
      ok: true,
      signature,
      explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      payment
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tool/balance', authTool, async (req, res) => {
  const balanceSol = await getBalanceSol(req.user.wallet.publicKey);
  res.json({ walletAddress: req.user.wallet.publicKey, balanceSol });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`LLM Wallet Hub running on ${APP_BASE_URL}`);
});
