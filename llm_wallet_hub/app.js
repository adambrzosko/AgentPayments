import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import { fileURLToPath } from 'url';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:8787';
const MASTER_KEY = process.env.MASTER_KEY || '';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PAYMENTS_DRY_RUN = process.env.PAYMENTS_DRY_RUN === 'true';
const BOT_WALLET_SECRET_KEY = process.env.BOT_WALLET_SECRET_KEY || '';
const BOT_WALLET_FILE = process.env.BOT_WALLET_FILE || path.resolve(__dirname, '..', 'jsons', 'bot-wallet.json');
const FAUCET_TOPUP_SOL = Number(process.env.FAUCET_TOPUP_SOL || 0.5);

if (!MASTER_KEY && process.env.NODE_ENV !== 'test') {
  throw new Error('MASTER_KEY is required');
}
if (MASTER_KEY && MASTER_KEY.length < 32) {
  throw new Error('MASTER_KEY must be at least 32 chars');
}

const DB_PATH = process.env.DB_PATH || (process.env.VERCEL ? '/tmp/llm-wallet-hub-db.json' : path.join(__dirname, 'data', 'db.json'));
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const rate = new Map();
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    const arr = (rate.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    rate.set(key, arr);
    if (arr.length > max) return res.status(429).json({ error: 'rate limited' });
    next();
  };
}

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
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

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function encryptSecret(secretBase58) {
  const iv = crypto.randomBytes(12);
  const key = deriveKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secretBase58, 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('hex') };
}

function decryptSecret(enc) {
  const key = deriveKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(enc.data, 'hex')), decipher.final()]).toString('utf8');
}

function issueToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function parseEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

function parseSolanaAddress(value) {
  try {
    return new PublicKey(String(value)).toBase58();
  } catch {
    return null;
  }
}

function authUser(req, res, next) {
  const token = String(req.headers['x-session-token'] || '');
  if (!token) return res.status(401).json({ error: 'Missing session token' });
  const tokenHash = hashToken(token);
  const db = readDb();
  const user = db.users.find((u) => u.sessionTokenHash === tokenHash && (!u.sessionExpiresAt || Date.now() < new Date(u.sessionExpiresAt).getTime()));
  if (!user) return res.status(401).json({ error: 'Invalid session token' });
  req.user = user;
  req.db = db;
  next();
}

function authTool(req, res, next) {
  const raw = String(req.headers['x-wallet-tool-key'] || '');
  if (!raw.startsWith('ak_')) return res.status(401).json({ error: 'Missing wallet tool key' });
  const keyPrefix = raw.slice(0, 12);
  const keyHash = hashToken(raw);
  const db = readDb();
  const apiKey = db.apiKeys.find((k) => k.keyPrefix === keyPrefix && k.keyHash === keyHash && k.active);
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
    allowlistedRecipients: apiKey.allowlistedRecipients?.length ? apiKey.allowlistedRecipients : user.policy.allowlistedRecipients
  };
}

async function getBalanceSol(publicKeyString) {
  const lamports = await connection.getBalance(new PublicKey(publicKeyString));
  return lamports / LAMPORTS_PER_SOL;
}

async function transferSol(fromSecretBase58, toAddress, amountSol) {
  if (PAYMENTS_DRY_RUN) return `dryrun_${crypto.randomUUID()}`;
  const fromKeypair = Keypair.fromSecretKey(bs58.decode(fromSecretBase58));
  const toPubkey = new PublicKey(toAddress);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: fromKeypair.publicKey, toPubkey, lamports }));
  const signature = await connection.sendTransaction(tx, [fromKeypair]);
  await connection.confirmTransaction(signature, 'confirmed');
  return signature;
}

function getBotWalletSecret() {
  if (BOT_WALLET_SECRET_KEY) return BOT_WALLET_SECRET_KEY;
  if (!fs.existsSync(BOT_WALLET_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(BOT_WALLET_FILE, 'utf8'));
    return typeof raw.secretKey === 'string' ? raw.secretKey : null;
  } catch {
    return null;
  }
}

function isDevnetRpc(url) {
  return String(url || '').toLowerCase().includes('devnet');
}

app.post('/api/signup', rateLimit('signup', 20, 15 * 60 * 1000), (req, res) => {
  try {
    const email = parseEmail(req.body.email);
    const password = String(req.body.password || '');
    if (!email || password.length < 10) return res.status(400).json({ error: 'Valid email + password (min 10 chars) required' });

    const db = readDb();
    if (db.users.some((u) => u.email === email)) return res.status(409).json({ error: 'Email already exists' });

    const kp = Keypair.generate();
    const secret58 = bs58.encode(kp.secretKey);
    const sessionToken = issueToken(24);
    const user = {
      id: crypto.randomUUID(),
      email,
      passwordHash: hashPassword(password),
      wallet: { publicKey: kp.publicKey.toBase58(), encryptedSecret: encryptSecret(secret58) },
      policy: { maxSolPerPayment: 0.05, dailySolCap: 0.2, allowlistedRecipients: [] },
      sessionTokenHash: hashToken(sessionToken),
      sessionExpiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString()
    };

    db.users.push(user);
    writeDb(db);

    res.json({ sessionToken, user: { id: user.id, email: user.email, walletAddress: user.wallet.publicKey, policy: user.policy } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', rateLimit('login', 30, 15 * 60 * 1000), (req, res) => {
  const email = parseEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!email) return res.status(401).json({ error: 'Invalid credentials' });

  const db = readDb();
  const user = db.users.find((u) => u.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) return res.status(401).json({ error: 'Invalid credentials' });

  const sessionToken = issueToken(24);
  user.sessionTokenHash = hashToken(sessionToken);
  user.sessionExpiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  writeDb(db);

  res.json({ sessionToken, user: { id: user.id, email: user.email, walletAddress: user.wallet.publicKey, policy: user.policy } });
});

app.get('/api/me', authUser, async (req, res) => {
  const balanceSol = await getBalanceSol(req.user.wallet.publicKey);
  res.json({ id: req.user.id, email: req.user.email, walletAddress: req.user.wallet.publicKey, balanceSol, policy: req.user.policy });
});

app.post('/api/faucet', authUser, async (req, res) => {
  try {
    if (!isDevnetRpc(SOLANA_RPC_URL)) {
      return res.status(400).json({ error: 'Faucet funding is devnet-only' });
    }

    const target = req.user.wallet.publicKey;
    const amountSol = Number.isFinite(Number(req.body?.amountSol)) ? Number(req.body.amountSol) : FAUCET_TOPUP_SOL;
    if (!Number.isFinite(amountSol) || amountSol <= 0 || amountSol > 2) {
      return res.status(400).json({ error: 'amountSol must be between 0 and 2' });
    }

    const amountLamports = Math.round(amountSol * LAMPORTS_PER_SOL);

    if (PAYMENTS_DRY_RUN) {
      return res.json({
        ok: true,
        dryRun: true,
        method: 'dry-run',
        amountSol,
        walletAddress: target,
        signature: `dryrun_${crypto.randomUUID()}`
      });
    }

    try {
      const airdropSig = await connection.requestAirdrop(new PublicKey(target), amountLamports);
      await connection.confirmTransaction(airdropSig, 'confirmed');
      const balanceSol = await getBalanceSol(target);
      return res.json({ ok: true, method: 'airdrop', amountSol, walletAddress: target, signature: airdropSig, balanceSol });
    } catch (airdropErr) {
      const botSecret = getBotWalletSecret();
      if (!botSecret) {
        return res.status(503).json({
          error: 'Airdrop failed and bot wallet fallback is not configured',
          details: String(airdropErr?.message || airdropErr)
        });
      }

      const fallbackSig = await transferSol(botSecret, target, amountSol);
      const balanceSol = await getBalanceSol(target);
      return res.json({
        ok: true,
        method: 'bot-wallet-fallback',
        amountSol,
        walletAddress: target,
        signature: fallbackSig,
        balanceSol,
        note: 'Airdrop failed, funded from bot wallet instead',
        airdropError: String(airdropErr?.message || airdropErr)
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/keys', authUser, (req, res) => {
  const name = String(req.body.name || 'default').slice(0, 80);
  const maxSolPerPayment = req.body.maxSolPerPayment != null ? Number(req.body.maxSolPerPayment) : null;
  const dailySolCap = req.body.dailySolCap != null ? Number(req.body.dailySolCap) : null;
  const allowlistedRecipients = Array.isArray(req.body.allowlistedRecipients)
    ? req.body.allowlistedRecipients.map(parseSolanaAddress).filter(Boolean)
    : [];

  if (maxSolPerPayment != null && (!Number.isFinite(maxSolPerPayment) || maxSolPerPayment <= 0)) return res.status(400).json({ error: 'Invalid maxSolPerPayment' });
  if (dailySolCap != null && (!Number.isFinite(dailySolCap) || dailySolCap <= 0)) return res.status(400).json({ error: 'Invalid dailySolCap' });

  const rawKey = `ak_${issueToken(20)}`;
  const newKey = {
    id: crypto.randomUUID(),
    userId: req.user.id,
    name,
    keyPrefix: rawKey.slice(0, 12),
    keyHash: hashToken(rawKey),
    active: true,
    maxSolPerPayment,
    dailySolCap,
    allowlistedRecipients,
    createdAt: new Date().toISOString()
  };
  req.db.apiKeys.push(newKey);
  writeDb(req.db);
  res.json({ ...newKey, rawKey });
});

app.get('/api/keys', authUser, (req, res) => {
  const keys = req.db.apiKeys.filter((k) => k.userId === req.user.id).map((k) => ({ ...k, keyHash: undefined }));
  res.json(keys);
});

app.post('/api/policy', authUser, (req, res) => {
  const { maxSolPerPayment, dailySolCap, allowlistedRecipients } = req.body;
  if (maxSolPerPayment != null) {
    const n = Number(maxSolPerPayment);
    if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'Invalid maxSolPerPayment' });
    req.user.policy.maxSolPerPayment = n;
  }
  if (dailySolCap != null) {
    const n = Number(dailySolCap);
    if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'Invalid dailySolCap' });
    req.user.policy.dailySolCap = n;
  }
  if (Array.isArray(allowlistedRecipients)) {
    req.user.policy.allowlistedRecipients = allowlistedRecipients.map(parseSolanaAddress).filter(Boolean);
  }
  writeDb(req.db);
  res.json(req.user.policy);
});

app.get('/api/system-prompt', authUser, (req, res) => {
  const { model = 'gpt' } = req.query;
  const prompt = `You can use a wallet payment tool for paywalled websites.\n\nRULES:\n1) Request quote/challenge first.\n2) Pay only if needed for user objective.\n3) Keep payments minimal.\n4) Give 1-line reason for each payment.\n\nTool name: wallet_pay\nInput:\n{\n  "recipient": "<solana address>",\n  "amountSol": 0.01,\n  "reason": "<why needed>",\n  "resourceUrl": "https://example.com/article"\n}\n\nTool endpoint:\nPOST ${APP_BASE_URL}/api/tool/pay\nHeader: x-wallet-tool-key: <USER_TOOL_KEY>\nOptional Header: x-idempotency-key: <uuid>`;
  res.json({ model, prompt });
});

app.post('/api/tool/pay', rateLimit('pay', 120, 15 * 60 * 1000), authTool, async (req, res) => {
  try {
    const recipient = parseSolanaAddress(req.body.recipient);
    const amount = Number(req.body.amountSol);
    const reason = String(req.body.reason || '').slice(0, 500);
    const resourceUrl = String(req.body.resourceUrl || '').slice(0, 1200);
    const idem = String(req.headers['x-idempotency-key'] || '').trim();

    if (!recipient || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Valid recipient and amountSol required' });

    if (idem) {
      const existing = req.db.payments.find((p) => p.userId === req.user.id && p.idempotencyKey === idem);
      if (existing) {
        return res.json({ ok: true, replay: true, signature: existing.signature, payment: existing, explorer: `https://explorer.solana.com/tx/${existing.signature}?cluster=devnet` });
      }
    }

    const policy = getPolicy(req.user, req.apiKey);
    if (amount > policy.maxSolPerPayment) return res.status(403).json({ error: `amount exceeds per-payment limit (${policy.maxSolPerPayment} SOL)` });
    if (policy.allowlistedRecipients.length > 0 && !policy.allowlistedRecipients.includes(recipient)) return res.status(403).json({ error: 'recipient not in allowlist' });

    const since = Date.now() - 24 * 3600 * 1000;
    const paidToday = req.db.payments
      .filter((p) => p.userId === req.user.id && new Date(p.createdAt).getTime() >= since)
      .reduce((sum, p) => sum + p.amountSol, 0);
    if (paidToday + amount > policy.dailySolCap) return res.status(403).json({ error: 'daily cap exceeded' });

    const balance = await getBalanceSol(req.user.wallet.publicKey);
    if (!PAYMENTS_DRY_RUN && balance < amount + 0.00001) return res.status(402).json({ error: 'insufficient balance' });

    const secret58 = decryptSecret(req.user.wallet.encryptedSecret);
    const signature = await transferSol(secret58, recipient, amount);

    const payment = {
      id: crypto.randomUUID(),
      idempotencyKey: idem || null,
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

    res.json({ ok: true, signature, explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`, payment });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tool/balance', authTool, async (req, res) => {
  const balanceSol = await getBalanceSol(req.user.wallet.publicKey);
  res.json({ walletAddress: req.user.wallet.publicKey, balanceSol });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

export default app;
