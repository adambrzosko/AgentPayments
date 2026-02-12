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
const SIG_SCAN_LIMIT = 50;

function isDevnet(rpcUrl) {
  return String(rpcUrl || '').toLowerCase().includes('devnet');
}

function getUsdcMint(rpcUrl) {
  return isDevnet(rpcUrl) ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
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
  const connection = new Connection(rpcUrl, 'confirmed');
  const usdcMint = getUsdcMint(rpcUrl);

  // Collect addresses to scan: main wallet + its USDC ATAs
  const addressesToScan = [walletAddress];
  try {
    const tokenAccounts = await getTokenAccounts(connection, walletAddress, usdcMint);
    addressesToScan.push(...tokenAccounts);
  } catch {
    // If token account lookup fails, still try the main wallet
  }

  // Gather unique signatures across all addresses
  const seen = new Set();
  const allSigs = [];
  for (const addr of addressesToScan) {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(addr), { limit: SIG_SCAN_LIMIT }, 'confirmed');
    for (const s of sigs) {
      if (!seen.has(s.signature)) {
        seen.add(s.signature);
        allSigs.push(s);
      }
    }
  }

  // Check each transaction for memo + USDC transfer
  for (const sigInfo of allSigs) {
    if (sigInfo.err) continue;

    const tx = await connection.getParsedTransaction(sigInfo.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
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
