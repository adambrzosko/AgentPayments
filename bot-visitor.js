const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const {
  Connection,
  Keypair,
  Transaction,
  PublicKey,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const {
  getOrCreateAssociatedTokenAccount,
  createTransferCheckedInstruction,
  createMint,
  mintTo,
} = require("@solana/spl-token");
const { createMemoInstruction } = require("@solana/spl-memo");
const bs58 = require("bs58");

const TOKEN_DECIMALS = 6; // same as USDC
const DEVNET_RPC = "https://api.devnet.solana.com";
const BOT_WALLET_FILE = path.join(__dirname, "bot-wallet.json");

// ---------------------------------------------------------------------------
// Step 1: Parse the landing page with a headless browser (detected as bot)
// ---------------------------------------------------------------------------
async function parseLandingPage() {
  const filePath = "file://" + path.resolve(__dirname, "index.html");
  console.log("[1/5] Launching headless browser...");

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(filePath, { waitUntil: "networkidle0" });

  const walletAddress = await page.$eval(
    "#payment-wall p:nth-of-type(2) code",
    (el) => el.textContent.trim()
  );

  const refId = await page.$eval("#ref-id", (el) => el.textContent.trim());

  await browser.close();

  console.log("  Parsed wallet address:", walletAddress);
  console.log("  Parsed reference ID:", refId);

  return { walletAddress, refId };
}

// ---------------------------------------------------------------------------
// Step 2: Load or create a persistent bot wallet
// ---------------------------------------------------------------------------
function loadOrCreateBotWallet() {
  console.log("\n[2/5] Loading bot wallet...");

  if (fs.existsSync(BOT_WALLET_FILE)) {
    const data = JSON.parse(fs.readFileSync(BOT_WALLET_FILE, "utf-8"));
    const keypair = Keypair.fromSecretKey(bs58.decode(data.secretKey));
    console.log("  Loaded existing wallet:", keypair.publicKey.toBase58());
    return keypair;
  }

  // First run — generate and save a new wallet
  const keypair = Keypair.generate();
  const data = {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(keypair.secretKey),
  };
  fs.writeFileSync(BOT_WALLET_FILE, JSON.stringify(data, null, 2) + "\n");
  console.log("  Created new wallet:", keypair.publicKey.toBase58());
  console.log("  Saved to:", BOT_WALLET_FILE);
  return keypair;
}

// ---------------------------------------------------------------------------
// Step 3: Airdrop SOL to the bot wallet (skip if already funded)
// ---------------------------------------------------------------------------
async function fundWithSol(connection, keypair) {
  console.log("\n[3/5] Checking SOL balance...");

  const balance = await connection.getBalance(keypair.publicKey);
  const balanceSol = balance / LAMPORTS_PER_SOL;
  console.log("  Current balance:", balanceSol, "SOL");

  if (balanceSol >= 0.5) {
    console.log("  Sufficient balance, skipping airdrop.");
    return;
  }

  console.log("  Requesting SOL airdrop on devnet...");
  const amounts = [2 * LAMPORTS_PER_SOL, 1 * LAMPORTS_PER_SOL, 0.5 * LAMPORTS_PER_SOL];
  const maxRetries = 3;

  for (const amount of amounts) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`  Attempting ${amount / LAMPORTS_PER_SOL} SOL airdrop (attempt ${attempt})...`);
        const airdropSig = await connection.requestAirdrop(keypair.publicKey, amount);
        await connection.confirmTransaction(airdropSig, "confirmed");
        const newBalance = await connection.getBalance(keypair.publicKey);
        console.log("  Airdrop confirmed. Balance:", newBalance / LAMPORTS_PER_SOL, "SOL");
        return;
      } catch (err) {
        console.log(`  Airdrop failed: ${err.message}`);
        if (attempt < maxRetries) {
          const wait = attempt * 5;
          console.log(`  Retrying in ${wait}s...`);
          await new Promise((r) => setTimeout(r, wait * 1000));
        }
      }
    }
  }

  throw new Error("Could not airdrop SOL after all attempts. Devnet faucet may be rate-limited — try again later.");
}

// ---------------------------------------------------------------------------
// Step 4: Create a mock USDC token and mint tokens to the bot wallet
// ---------------------------------------------------------------------------
async function createAndMintToken(connection, botKeypair) {
  console.log("\n[4/5] Creating mock USDC token on devnet...");

  // Create a new SPL token mint (bot is mint authority)
  const mint = await createMint(
    connection,
    botKeypair,           // payer
    botKeypair.publicKey, // mint authority
    null,                 // freeze authority (none)
    TOKEN_DECIMALS        // decimals (6, like USDC)
  );

  console.log("  Mock USDC mint:", mint.toBase58());

  // Create the bot's associated token account for this mint
  const botAta = await getOrCreateAssociatedTokenAccount(
    connection,
    botKeypair,
    mint,
    botKeypair.publicKey
  );

  // Mint just 1 token (enough for the smallest transfer)
  const mintAmount = 1 * 10 ** TOKEN_DECIMALS;
  await mintTo(
    connection,
    botKeypair,           // payer
    mint,                 // the token mint
    botAta.address,       // destination ATA
    botKeypair.publicKey, // mint authority
    mintAmount            // raw amount
  );

  console.log("  Minted 1 token to bot wallet");

  return { mint, botAta };
}

// ---------------------------------------------------------------------------
// Step 5: Send the smallest possible amount to the recipient with memo
// ---------------------------------------------------------------------------
async function sendToken(connection, botKeypair, mint, botAta, recipientAddress, refId) {
  const smallest = 1; // 1 raw unit = 0.000001 tokens (with 6 decimals)
  console.log("\n[5/5] Sending 0.000001 mock USDC to recipient...");
  const recipientPubkey = new PublicKey(recipientAddress);

  console.log("  From:", botKeypair.publicKey.toBase58());
  console.log("  To:", recipientAddress);
  console.log("  Mint:", mint.toBase58());
  console.log("  Amount: 0.000001 token (1 raw unit)");
  console.log("  Memo:", refId);

  // Get or create the recipient's ATA (bot pays for creation)
  const recipientAta = await getOrCreateAssociatedTokenAccount(
    connection,
    botKeypair,
    mint,
    recipientPubkey
  );

  // Build the transaction: memo + transfer
  const transaction = new Transaction();

  transaction.add(createMemoInstruction(refId, [botKeypair.publicKey]));

  transaction.add(
    createTransferCheckedInstruction(
      botAta.address,
      mint,
      recipientAta.address,
      botKeypair.publicKey,
      smallest,
      TOKEN_DECIMALS
    )
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [
    botKeypair,
  ]);

  console.log("\n  Transaction successful!");
  console.log("  Signature:", signature);
  console.log(
    "  Explorer:",
    `https://explorer.solana.com/tx/${signature}?cluster=devnet`
  );

  return signature;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Parse the landing page to get the target wallet and reference ID
  const { walletAddress, refId } = await parseLandingPage();

  // Load or create a persistent bot wallet
  const botKeypair = loadOrCreateBotWallet();

  // Connect to devnet
  const connection = new Connection(DEVNET_RPC, "confirmed");

  // Fund the bot wallet with SOL (skips if already funded)
  await fundWithSol(connection, botKeypair);

  // Create a mock USDC token and mint tokens to the bot
  const { mint, botAta } = await createAndMintToken(connection, botKeypair);

  // Send the smallest possible amount to the website's wallet with the reference ID in the memo
  await sendToken(connection, botKeypair, mint, botAta, walletAddress, refId);

  console.log("\nDone. Bot successfully paid to access the site.");
}

main().catch((err) => {
  console.error("Bot visitor failed:", err);
  process.exit(1);
});
