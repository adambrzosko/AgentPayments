/**
 * AgentPayments live demo — watch an AI agent pay through a paywall in real time.
 *
 * The server plays both roles: it hosts a paywalled resource gated by the real
 * published @agentpayments/node package, and it holds a devnet-funded "agent"
 * wallet that autonomously pays for access, exactly the way a real AI agent
 * would. Every step (the 402, the on-chain payment, the retry) is real —
 * streamed to the browser over SSE as it happens. Devnet only: this wallet
 * never holds anything of real value.
 */
'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const bs58 = require('bs58');
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} = require('@solana/spl-token');
const { agentPaymentsGate } = require('@agentpayments/node');

const PORT = Number.parseInt(process.env.PORT || '3100', 10);
const HOST = process.env.HOST || '0.0.0.0';
// The internal self-requests always target loopback regardless of HOST —
// they're same-process, never need to leave the container.
const SELF_URL = `http://127.0.0.1:${PORT}`;

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const USDC_MINT = new PublicKey(process.env.USDC_MINT_DEVNET || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const VENDOR_WALLET = new PublicKey(process.env.DEMO_VENDOR_WALLET || '6P7oBxEip77cRDrk6Yr5tDx6XMUATntYoEe2XE9pH9xi');

if (!process.env.DEMO_AGENT_SECRET) {
  throw new Error('DEMO_AGENT_SECRET env var is required (base58 secret key of the devnet-funded demo agent wallet)');
}
const agentKeypair = Keypair.fromSecretKey(bs58.decode(process.env.DEMO_AGENT_SECRET));
const connection = new Connection(RPC_URL, 'confirmed');

// A real AI agent hitting a gated endpoint must look like one over the wire.
// Node's built-in fetch() always adds `sec-fetch-mode: cors` (undocumented,
// not overridable) — a header isBrowser() treats as browser-proof, so a
// fetch()-based caller gets misclassified as a browser. Use plain http.request
// here so the demo genuinely exercises the machine/agent code path.
function agentRequest(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${SELF_URL}${pathname}`, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (err) {
          reject(new Error(`Non-JSON response (status ${res.statusCode}): ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function memoInstruction(text) {
  return new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(text, 'utf-8'),
  });
}

const app = express();
app.disable('x-powered-by');

// The paywalled resource — gated by the real published package, same as any
// customer's app would be. debug:true keeps this on devnet. Scoped to this
// one route only — /api/run-demo (the orchestrator) must stay reachable.
app.use('/api/premium-content', agentPaymentsGate({
  challengeSecret: process.env.CHALLENGE_SECRET || crypto.randomBytes(32).toString('hex'),
  homeWalletAddress: VENDOR_WALLET.toBase58(),
  solanaRpcUrl: RPC_URL,
  debug: true,
}));

app.get('/api/premium-content', (_req, res) => {
  res.json({
    ok: true,
    headline: 'You are in.',
    body: 'This response only exists because a Solana transaction with the right memo landed on-chain in the last few seconds. No API key was issued by hand, no account was created — the agent paid its way in.',
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Demo orchestration -----------------------------------------------------

let demoRunning = false;
const rateLimit = new Map(); // ip -> {count, windowStart}
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimit.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count += 1;
  return true;
}

app.get('/api/run-demo', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (step, payload) => res.write(`data: ${JSON.stringify({ step, ...payload })}\n\n`);

  if (!checkRateLimit(ip)) {
    send('error', { message: 'Rate limit reached — try again in a few minutes.' });
    return res.end();
  }
  if (demoRunning) {
    send('error', { message: 'Demo is running for another visitor right now — try again in a moment.' });
    return res.end();
  }

  demoRunning = true;
  try {
    send('start', { message: 'Agent requests GET /api/premium-content (no payment yet)...' });
    const first = await agentRequest('/api/premium-content', { 'User-Agent': 'agentpayments-live-demo-agent/1.0' });

    if (first.status !== 402) {
      send('error', { message: `Expected 402, got ${first.status}. ${first.body.message || ''}` });
      return res.end();
    }
    send('challenged', {
      status: 402,
      message: 'Server responded 402 Payment Required.',
      body: first.body,
    });

    const { wallet_address: destWallet, amount, memo } = first.body.payment;
    const agentKey = first.body.your_key;
    const amountBaseUnits = BigInt(Math.round(Number(amount) * 1_000_000));

    send('building', { message: `Agent builds a transaction: ${amount} USDC + memo "${memo}"...` });

    const destOwner = new PublicKey(destWallet);
    const agentAta = await getAssociatedTokenAddress(USDC_MINT, agentKeypair.publicKey);
    const vendorAta = await getAssociatedTokenAddress(USDC_MINT, destOwner);

    const tx = new Transaction()
      .add(createAssociatedTokenAccountIdempotentInstruction(agentKeypair.publicKey, vendorAta, destOwner, USDC_MINT))
      .add(createTransferCheckedInstruction(agentAta, USDC_MINT, vendorAta, agentKeypair.publicKey, amountBaseUnits, 6))
      .add(memoInstruction(memo));
    tx.feePayer = agentKeypair.publicKey;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(agentKeypair);

    const signature = await connection.sendRawTransaction(tx.serialize());
    send('sent', {
      message: 'Transaction sent to Solana devnet. Confirming...',
      signature,
      explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    });

    await connection.confirmTransaction(signature, 'confirmed');
    send('confirmed', { message: 'Transaction confirmed on-chain.', signature });

    // The gate verifies at commitment:'finalized' (~10-20s slower than the
    // 'confirmed' commitment used above, traded for irreversibility — see
    // CLAUDE.md) AND caches a negative verification result for 30s (DoS
    // protection, see ROADMAP P0 #4). Retrying quickly would just re-read
    // that stale cached "not verified" answer instead of re-checking the
    // chain — so wait out finalization BEFORE the first attempt, and if that
    // one still lands in the negative-cache window, wait the full TTL before
    // trying again rather than polling.
    send('waiting', { message: 'Waiting ~20s for the transaction to reach finalized commitment before checking...' });
    await new Promise((r) => setTimeout(r, 20000));

    send('retrying', { message: 'Agent retries GET /api/premium-content with X-Agent-Key...' });
    let second = await agentRequest('/api/premium-content', {
      'User-Agent': 'agentpayments-live-demo-agent/1.0',
      'X-Agent-Key': agentKey,
    });
    if (second.status !== 200) {
      send('waiting', { message: `${second.body.message || second.status} — waiting 30s for the negative-result cache to expire, then retrying once more...` });
      await new Promise((r) => setTimeout(r, 30000));
      second = await agentRequest('/api/premium-content', {
        'User-Agent': 'agentpayments-live-demo-agent/1.0',
        'X-Agent-Key': agentKey,
      });
    }

    if (second.status !== 200) {
      send('error', { message: `Retry failed: got ${second.status}. ${second.body.message || ''}` });
      return res.end();
    }
    send('granted', { status: 200, message: 'Access granted.', body: second.body });
  } catch (err) {
    send('error', { message: err.message || String(err) });
  } finally {
    demoRunning = false;
    res.end();
  }
});

app.listen(PORT, HOST, () => {
  console.log(`AgentPayments live demo listening on http://${HOST}:${PORT}`);
});

module.exports = app;
