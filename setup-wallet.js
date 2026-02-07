const { Keypair } = require("@solana/web3.js");
const bip39 = require("bip39");
const { derivePath } = require("ed25519-hd-key");
const bs58 = require("bs58");
const fs = require("fs");
const path = require("path");

const OUTPUT_FILE = path.join(__dirname, "wallet-keys.json");

async function main() {
  if (fs.existsSync(OUTPUT_FILE)) {
    console.error(`Error: ${OUTPUT_FILE} already exists. Delete it first if you want to generate a new wallet.`);
    process.exit(1);
  }

  // Generate a 12-word mnemonic
  const mnemonic = bip39.generateMnemonic();

  // Derive a Solana keypair from the mnemonic using the standard derivation path
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString("hex")).key;
  const keypair = Keypair.fromSeed(derivedSeed);

  const walletData = {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(keypair.secretKey),
    mnemonic: mnemonic,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(walletData, null, 2) + "\n");

  console.log("Solana wallet created successfully!");
  console.log(`Public key: ${walletData.publicKey}`);
  console.log(`Credentials saved to: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error("Failed to create wallet:", err);
  process.exit(1);
});
