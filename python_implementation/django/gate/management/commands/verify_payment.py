from django.conf import settings
from django.core.management.base import BaseCommand

from gate.services.solana import derive_payment_memo, verify_payment_via_backend


class Command(BaseCommand):
    help = "Verify a USDC payment via the backend for a given agent key"

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
        verify_url = settings.AGENTPAYMENTS_VERIFY_URL
        gate_secret = settings.AGENTPAYMENTS_GATE_SECRET

        if not wallet:
            self.stderr.write(
                self.style.ERROR("Error: No wallet address. Set HOME_WALLET_ADDRESS in .env or use --wallet.")
            )
            return

        if not verify_url or not gate_secret:
            self.stderr.write(
                self.style.ERROR("Error: AGENTPAYMENTS_VERIFY_URL and AGENTPAYMENTS_GATE_SECRET must be set.")
            )
            return

        memo = derive_payment_memo(agent_key, settings.CHALLENGE_SECRET)
        self.stdout.write(f"Wallet:    {wallet}")
        self.stdout.write(f"Agent key: {agent_key}")
        self.stdout.write(f"Memo:      {memo}")
        self.stdout.write(f"Verify URL: {verify_url}")
        self.stdout.write("")

        result = verify_payment_via_backend(memo, wallet, verify_url, gate_secret)

        if result:
            self.stdout.write(self.style.SUCCESS("VERIFIED - payment found."))
        else:
            self.stdout.write(self.style.ERROR("NOT VERIFIED - no matching payment found."))
