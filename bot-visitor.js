const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const {
  Connection,
  Keypair,
  Transaction,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const { createMemoInstruction } = require("@solana/spl-memo");
const bs58 = require("bs58");

const DEVNET_RPC = "https://api.devnet.solana.com";
const BOT_WALLET_FILE = path.join(__dirname, "bot-wallet.json");

// ---------------------------------------------------------------------------
// Step 1: Launch browser and parse the landing page (keep browser open)
// ---------------------------------------------------------------------------
async function launchAndParsePage() {
  const filePath = "file://" + path.resolve(__dirname, "index.html");
  console.log("[1/5] Launching headless browser...");

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--disable-web-security", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage();

  // Log browser console errors for debugging
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`  [browser error]`, msg.text());
    }
  });

  await page.goto(filePath, { waitUntil: "networkidle0" });

  const walletAddress = await page.$eval(
    "#payment-wall p:nth-of-type(2) code",
    (el) => el.textContent.trim()
  );

  const refId = await page.$eval("#ref-id", (el) => el.textContent.trim());

  console.log("  Parsed wallet address:", walletAddress);
  console.log("  Parsed reference ID:", refId);

  return { browser, page, walletAddress, refId };
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

  if (balanceSol >= 0.1) {
    console.log("  Sufficient balance, skipping airdrop.");
    return;
  }

  console.log("  Requesting SOL airdrop on devnet...");
  const amounts = [1 * LAMPORTS_PER_SOL, 0.5 * LAMPORTS_PER_SOL];
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

  throw new Error("Could not airdrop SOL. Devnet faucet may be rate-limited — try again later.");
}

// ---------------------------------------------------------------------------
// Step 4: Send smallest SOL transfer with the reference ID as memo
// ---------------------------------------------------------------------------
async function sendPayment(connection, botKeypair, recipientAddress, refId) {
  console.log("\n[4/5] Sending payment with memo...");
  const recipientPubkey = new PublicKey(recipientAddress);
  const lamports = 1_000_000; // 0.001 SOL (enough to cover rent-exempt minimum)

  console.log("  From:", botKeypair.publicKey.toBase58());
  console.log("  To:", recipientAddress);
  console.log("  Amount: 0.001 SOL");
  console.log("  Memo:", refId);

  const transaction = new Transaction();

  // Memo instruction first
  transaction.add(createMemoInstruction(refId, [botKeypair.publicKey]));

  // SOL transfer (1 lamport — smallest possible)
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: botKeypair.publicKey,
      toPubkey: recipientPubkey,
      lamports: lamports,
    })
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
// Step 5: Wait for the page to detect the payment and grant access
// ---------------------------------------------------------------------------
async function waitForAccess(page) {
  console.log("\n[5/5] Waiting for page to verify payment and grant access...");

  const timeout = 120000; // 2 minutes
  const pollInterval = 2000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const granted = await page.evaluate(() => {
      const gated = document.getElementById("gated-content");
      return gated && gated.style.display === "block";
    });

    if (granted) {
      console.log("  Access granted! Gated content is now visible.");
      return true;
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  console.log("  Timed out waiting for access.");
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { browser, page, walletAddress, refId } = await launchAndParsePage();

  try {
    const botKeypair = loadOrCreateBotWallet();
    const connection = new Connection(DEVNET_RPC, "confirmed");

    await fundWithSol(connection, botKeypair);
    await sendPayment(connection, botKeypair, walletAddress, refId);

    const accessGranted = await waitForAccess(page);

    if (accessGranted) {
      const pageTitle = await page.$eval(
        "#gated-content .hero h2",
        (el) => el.textContent.trim()
      );
      console.log(`\n  Page content title: "${pageTitle}"`);
      console.log("\nDone. Bot successfully paid and accessed the site.");
    } else {
      console.log("\nDone. Payment was sent but page did not grant access within timeout.");
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Bot visitor failed:", err);
  process.exit(1);
});
