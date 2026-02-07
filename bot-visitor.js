const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const {
  Connection,
  Keypair,
  Transaction,
  PublicKey,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
  getOrCreateAssociatedTokenAccount,
  createTransferCheckedInstruction,
} = require("@solana/spl-token");
const { createMemoInstruction } = require("@solana/spl-memo");
const bs58 = require("bs58");

// Devnet USDC mint (Circle)
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const USDC_DECIMALS = 6;
const DEVNET_RPC = "https://api.devnet.solana.com";

async function parseLandingPage() {
  const filePath = "file://" + path.resolve(__dirname, "index.html");
  console.log("Launching headless browser...");

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(filePath, { waitUntil: "networkidle0" });

  // The bot detection in the page should trigger the payment wall automatically.
  // Extract the wallet address and reference ID from the payment wall.
  const walletAddress = await page.$eval(
    "#payment-wall p:nth-of-type(2) code",
    (el) => el.textContent.trim()
  );

  const refId = await page.$eval("#ref-id", (el) => el.textContent.trim());

  await browser.close();

  console.log("Parsed from landing page:");
  console.log("  Wallet address:", walletAddress);
  console.log("  Reference ID:", refId);

  return { walletAddress, refId };
}

function loadBotWallet() {
  const keysPath = path.join(__dirname, "wallet-keys.json");
  if (!fs.existsSync(keysPath)) {
    console.error("Error: wallet-keys.json not found. Run setup-wallet.js first.");
    process.exit(1);
  }
  const keys = JSON.parse(fs.readFileSync(keysPath, "utf-8"));
  const secretKey = bs58.decode(keys.secretKey);
  return Keypair.fromSecretKey(secretKey);
}

async function sendUsdc(senderKeypair, recipientAddress, refId) {
  const connection = new Connection(DEVNET_RPC, "confirmed");
  const recipientPubkey = new PublicKey(recipientAddress);

  console.log("\nPreparing USDC transfer on devnet...");
  console.log("  From:", senderKeypair.publicKey.toBase58());
  console.log("  To:", recipientAddress);
  console.log("  Amount: 1 USDC");
  console.log("  Memo:", refId);

  // Get or create ATAs for sender and recipient
  const senderAta = await getOrCreateAssociatedTokenAccount(
    connection,
    senderKeypair,
    USDC_MINT,
    senderKeypair.publicKey
  );

  const recipientAta = await getOrCreateAssociatedTokenAccount(
    connection,
    senderKeypair,
    USDC_MINT,
    recipientPubkey
  );

  // Build transaction: memo + transfer
  const transaction = new Transaction();

  transaction.add(createMemoInstruction(refId, [senderKeypair.publicKey]));

  transaction.add(
    createTransferCheckedInstruction(
      senderAta.address,
      USDC_MINT,
      recipientAta.address,
      senderKeypair.publicKey,
      1 * 10 ** USDC_DECIMALS, // 1 USDC
      USDC_DECIMALS
    )
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [
    senderKeypair,
  ]);

  console.log("\nTransaction successful!");
  console.log("  Signature:", signature);
  console.log(
    "  Explorer:",
    `https://explorer.solana.com/tx/${signature}?cluster=devnet`
  );

  return signature;
}

async function main() {
  const { walletAddress, refId } = await parseLandingPage();
  const botWallet = loadBotWallet();
  await sendUsdc(botWallet, walletAddress, refId);
}

main().catch((err) => {
  console.error("Bot visitor failed:", err);
  process.exit(1);
});
