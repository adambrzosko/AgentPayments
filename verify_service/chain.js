/**
 * On-chain USDC payment verification for Solana.
 * Ported from scripts/verify_payment.py.
 *
 * Scans recent transactions on a wallet's USDC token accounts
 * looking for a transfer with a matching memo.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MIN_PAYMENT_USDC = 0.01;
const SIG_SCAN_LIMIT = 20;
const RPC_RETRIES = 3;
const TIME_BUDGET_MS = 8000;
const MAX_TX_TO_PARSE = 14;
const RETRYABLE_MESSAGES = ['429', 'Too Many Requests', 'fetch failed', 'ETIMEDOUT', 'ECONNRESET'];

function isDevnet(rpcUrl) {
  return String(rpcUrl || '').toLowerCase().includes('devnet');
}

function getUsdcMint(rpcUrl) {
  return isDevnet(rpcUrl) ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  const msg = String(err?.message || err || '');
  return RETRYABLE_MESSAGES.some((s) => msg.includes(s));
}

async function withRpcRetry(fn, label) {
  let lastErr;
  for (let i = 0; i < RPC_RETRIES; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || i === RPC_RETRIES - 1) {
        throw err;
      }
      const waitMs = 250 * Math.pow(2, i);
      console.warn(`[verify-service] ${label} retry ${i + 1}/${RPC_RETRIES} after error: ${String(err?.message || err)}`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

/**
 * Get all USDC token account addresses owned by a wallet.
 */
async function getTokenAccounts(connection, walletAddress, usdcMint) {
  const owner = new PublicKey(walletAddress);
  const mint = new PublicKey(usdcMint);
  const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint }, 'confirmed');
  return resp.value.map((a) => a.pubkey.toBase58());
}

/**
 * Scan recent transactions on a wallet for a USDC payment with a matching memo.
 *
 * @param {string} rpcUrl - Solana RPC URL
 * @param {string} walletAddress - Recipient wallet to scan
 * @param {string} memo - Memo string to match (the agent key)
 * @returns {{ paid: boolean, txSignature: string|null, amount: number|null }}
 */
export async function verifyPaymentOnChain(rpcUrl, walletAddress, memo) {
  const startedAt = Date.now();
  const isTimedOut = () => Date.now() - startedAt > TIME_BUDGET_MS;

  const connection = new Connection(rpcUrl, 'confirmed');
  const usdcMint = getUsdcMint(rpcUrl);

  // Collect addresses to scan. Prioritize USDC token accounts first because
  // payments land there; scanning the main wallet first can waste the time budget.
  let tokenAccounts = [];
  try {
    tokenAccounts = await withRpcRetry(
      () => getTokenAccounts(connection, walletAddress, usdcMint),
      'getTokenAccountsByOwner'
    );
  } catch {
    // If token account lookup fails, still try the main wallet
  }

  const addressesToScan = tokenAccounts.length > 0
    ? [...tokenAccounts, walletAddress]
    : [walletAddress];

  // Gather unique signatures across all addresses
  const seen = new Set();
  const allSigs = [];
  for (const addr of addressesToScan) {
    if (isTimedOut()) {
      console.warn('[verify-service] time budget exceeded while fetching signatures');
      break;
    }

    let sigs = [];
    try {
      sigs = await withRpcRetry(
        () => connection.getSignaturesForAddress(new PublicKey(addr), { limit: SIG_SCAN_LIMIT }, 'confirmed'),
        'getSignaturesForAddress'
      );
    } catch (err) {
      console.warn(`[verify-service] failed to fetch signatures for ${addr}: ${String(err?.message || err)}`);
      continue;
    }

    for (const s of sigs) {
      if (!seen.has(s.signature)) {
        seen.add(s.signature);
        allSigs.push(s);
      }
    }
  }

  // Check each transaction for memo + USDC transfer
  let parsedCount = 0;
  for (const sigInfo of allSigs) {
    if (parsedCount >= MAX_TX_TO_PARSE) {
      console.warn('[verify-service] tx parse cap reached');
      break;
    }
    if (isTimedOut()) {
      console.warn('[verify-service] time budget exceeded while scanning transactions');
      break;
    }

    if (sigInfo.err) continue;

    let tx;
    try {
      parsedCount += 1;
      tx = await withRpcRetry(
        () => connection.getParsedTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        }),
        'getParsedTransaction'
      );
    } catch (err) {
      console.warn(`[verify-service] failed to fetch transaction ${sigInfo.signature}: ${String(err?.message || err)}`);
      continue;
    }
    if (!tx) continue;

    const instructions = tx.transaction.message.instructions || [];
    const innerGroups = tx.meta?.innerInstructions || [];
    const allIx = [...instructions];
    for (const group of innerGroups) {
      allIx.push(...(group.instructions || []));
    }

    let hasMemo = false;
    let hasPayment = false;
    let paymentAmount = null;

    for (const ix of allIx) {
      // Check memo
      const program = ix.program || '';
      const programId = typeof ix.programId === 'string' ? ix.programId : ix.programId?.toBase58?.() || '';
      if (program === 'spl-memo' || programId === MEMO_PROGRAM_ID) {
        const parsed = ix.parsed || '';
        const memoText = typeof parsed === 'string' ? parsed : String(parsed);
        if (memoText.includes(memo)) {
          hasMemo = true;
        }
      }

      // Check USDC transfer
      if (program === 'spl-token') {
        const parsed = ix.parsed || {};
        const txType = parsed.type || '';
        if (txType === 'transfer' || txType === 'transferChecked') {
          const info = parsed.info || {};

          // For transferChecked, verify it's the right USDC mint
          if (txType === 'transferChecked' && info.mint !== usdcMint) continue;

          // Parse amount
          const tokenAmount = info.tokenAmount || {};
          let uiAmount = tokenAmount.uiAmount;
          if (uiAmount == null) {
            const raw = info.amount || '0';
            uiAmount = parseInt(raw, 10) / 1e6;
          }

          if (uiAmount >= MIN_PAYMENT_USDC) {
            hasPayment = true;
            paymentAmount = uiAmount;
          }
        }
      }
    }

    if (hasMemo && hasPayment) {
      return { paid: true, txSignature: sigInfo.signature, amount: paymentAmount };
    }
  }

  return { paid: false, txSignature: null, amount: null };
}
