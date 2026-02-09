# Next.js Deployment (Test Website)

Demo Next.js app wired with local AgentPayments middleware.

## Run locally
```bash
cd next_implementation
cp .env.example .env.local
npm install
npm run dev
```

## Vercel
Set these env vars in project settings:
- CHALLENGE_SECRET
- HOME_WALLET_ADDRESS
- SOLANA_RPC_URL (optional)
- USDC_MINT (optional)
- DEBUG
