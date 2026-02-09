#!/usr/bin/env python3
"""
Create a Solana wallet from a 12-word mnemonic and save it to wallet-keys.json.
"""

import json
import sys
from pathlib import Path

import base58
from bip_utils import (
    Bip39MnemonicGenerator,
    Bip39WordsNum,
    Bip39SeedGenerator,
    Bip44,
    Bip44Coins,
    Bip44Changes,
)
from solders.keypair import Keypair

OUTPUT_FILE = Path(__file__).resolve().parent / "wallet-keys.json"


def main() -> int:
    if OUTPUT_FILE.exists():
        print(f"Error: {OUTPUT_FILE} already exists. Delete it first if you want to generate a new wallet.")
        return 1

    mnemonic = Bip39MnemonicGenerator().FromWordsNumber(Bip39WordsNum.WORDS_NUM_12)
    seed = Bip39SeedGenerator(mnemonic).Generate()

    bip44 = Bip44.FromSeed(seed, Bip44Coins.SOLANA)
    account = bip44.Purpose().Coin().Account(0).Change(Bip44Changes.CHAIN_EXT).AddressIndex(0)
    private_key = account.PrivateKey().Raw().ToBytes()

    keypair = Keypair.from_seed(private_key)

    wallet_data = {
        "publicKey": str(keypair.pubkey()),
        "secretKey": base58.b58encode(bytes(keypair)).decode("utf-8"),
        "mnemonic": mnemonic,
    }

    OUTPUT_FILE.write_text(json.dumps(wallet_data, indent=2) + "\n")

    print("Solana wallet created successfully!")
    print(f"Public key: {wallet_data['publicKey']}")
    print(f"Credentials saved to: {OUTPUT_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
