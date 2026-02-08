import json
import os

from django.core.management.base import BaseCommand

import base58
from bip_utils import (
    Bip39MnemonicGenerator,
    Bip39SeedGenerator,
    Bip39WordsNum,
    Bip44,
    Bip44Coins,
    Bip44Changes,
)


class Command(BaseCommand):
    help = "Generate a new Solana wallet with BIP39 mnemonic"

    def add_arguments(self, parser):
        parser.add_argument(
            "--output",
            default="wallet-keys.json",
            help="Output file path (default: wallet-keys.json)",
        )

    def handle(self, *args, **options):
        output_file = options["output"]

        if os.path.exists(output_file):
            self.stderr.write(
                self.style.ERROR(
                    f"Error: {output_file} already exists. Delete it first if you want to generate a new wallet."
                )
            )
            return

        # Generate a 12-word BIP39 mnemonic
        mnemonic = Bip39MnemonicGenerator().FromWordsNumber(Bip39WordsNum.WORDS_NUM_12)

        # Derive Solana keypair using path m/44'/501'/0'/0'
        seed = Bip39SeedGenerator(mnemonic).Generate()
        bip44_ctx = Bip44.FromSeed(seed, Bip44Coins.SOLANA)
        keypair_bytes = (
            bip44_ctx
            .Purpose()
            .Coin()
            .Account(0)
            .Change(Bip44Changes.CHAIN_EXT)
            .PrivateKey()
            .Raw()
            .ToBytes()
        )

        # Solana keypair is 64 bytes: 32-byte secret + 32-byte public
        from solders.keypair import Keypair

        keypair = Keypair.from_seed(keypair_bytes[:32])

        wallet_data = {
            "publicKey": str(keypair.pubkey()),
            "secretKey": base58.b58encode(bytes(keypair)).decode(),
            "mnemonic": str(mnemonic),
        }

        with open(output_file, "w") as f:
            json.dump(wallet_data, f, indent=2)
            f.write("\n")

        self.stdout.write(self.style.SUCCESS("Solana wallet created successfully!"))
        self.stdout.write(f"Public key: {keypair.pubkey()}")
        self.stdout.write(f"Credentials saved to: {output_file}")
