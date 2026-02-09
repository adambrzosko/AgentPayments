from django.conf import settings
from django.core.management.base import BaseCommand

from gate.services.solana import (
    RPC_DEVNET,
    RPC_MAINNET,
    USDC_MINT_DEVNET,
    USDC_MINT_MAINNET,
    verify_payment_on_chain,
)


class Command(BaseCommand):
    help = "Verify a USDC payment on-chain for a given agent key"

    def add_arguments(self, parser):
        parser.add_argument("agent_key", help="The agent key to verify payment for")
        parser.add_argument(
            "--wallet",
            default="",
            help="Merchant wallet address (default: HOME_WALLET_ADDRESS from settings)",
        )

    def handle(self, *args, **options):
        agent_key = options["agent_key"]
        wallet = options["wallet"] or settings.HOME_WALLET_ADDRESS
        debug = settings.DEBUG
        rpc_url = settings.SOLANA_RPC_URL or (RPC_DEVNET if debug else RPC_MAINNET)
        usdc_mint = settings.USDC_MINT or (USDC_MINT_DEVNET if debug else USDC_MINT_MAINNET)
        network = "devnet" if debug else "mainnet"

        if not wallet:
            self.stderr.write(
                self.style.ERROR("Error: No wallet address. Set HOME_WALLET_ADDRESS in .env or use --wallet.")
            )
            return

        self.stdout.write(f"Wallet:    {wallet}")
        self.stdout.write(f"Agent key: {agent_key}")
        self.stdout.write(f"RPC:       {rpc_url}")
        self.stdout.write(f"Network:   {network}")
        self.stdout.write("")

        result = verify_payment_on_chain(agent_key, wallet, rpc_url, usdc_mint)

        if result:
            self.stdout.write(self.style.SUCCESS("VERIFIED - payment found on-chain."))
        else:
            self.stdout.write(self.style.ERROR("NOT VERIFIED - no matching payment found in recent transactions."))
