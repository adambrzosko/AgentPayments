## TODO

### Completed
* ~~Get sites hosted~~ — Cloudflare, Django (Oracle VM), Next.js (Vercel), Netlify all deployed
* ~~Package bot blocking into a library~~ — `sdk/node`, `sdk/edge`, `sdk/python`, `sdk/next` all complete
* ~~Figure out how to implement into the three deployments~~ — demo wrappers in `node_implementation/`, `edge_implementation/`, `python_implementation/`, `next_implementation/`
* ~~Centralize constants~~ — `sdk/constants.json` is single source of truth
* ~~Add TypeScript types~~ — `index.d.ts` for Node and Edge SDKs
* ~~Add payment verification caching~~ — 10-min TTL, 1000 entries max
* ~~Add rate limiting~~ — 20 req/min/IP on challenge verify
* ~~Add input size limits~~ — all user inputs capped
* ~~Add timing-safe HMAC comparison~~ — all SDKs
* ~~Add wallet address validation~~ — base58, 32-44 chars
* ~~Add default secret detection~~ — warn in debug, throw in production
* ~~Add structured JSON logging~~ — Node/Edge SDKs
* ~~Add challenge page accessibility~~ — spinner, noscript fallback, ARIA
* ~~Publish SDKs to npm / PyPI~~ — `@agentpayments/node`, `@agentpayments/edge`, `agentpayments-python` all live
* ~~Flesh out backend~~ — hosted platform API (`api/`) live on Railway: vendor accounts, hosted key issuance, usage dashboard
* ~~Charge vendors for hosted-platform usage~~ — on-chain fee (2% of `minPayment`, same-transaction two-leg verification), proven end-to-end against real devnet transactions
* ~~Connect a real domain~~ — `agentpayments.cloud` → Railway, `api.agentpayments.cloud` live with valid SSL

### In Progress
* Improve bot communication — ChatGPT and other LLM agents don't reliably read the 402 response instructions

### Up Next
* **Paid Solana RPC provider (Helius/Triton/QuickNode)** — public devnet RPC rate-limited us mid-test this session (confirms ROADMAP's "Production RPC strategy" item is real, not theoretical); needed before this handles real traffic without flaking
* Republish the 3 SDK packages with `PLATFORM_API_URL` defaulting to `api.agentpayments.cloud` instead of the old placeholder `api.agentpayments.dev` — deferred for now; until then, hosted-platform users must pass `platformApiUrl` / `AGENTPAYMENTS_PLATFORM_URL` explicitly
* A live, no-install demo (watch an agent actually pay through a paywall) — biggest lever for a HN/launch post landing well
* Proxy adapter (Nginx/Envoy style enforcement)
* Write a comprehensive test script to hit all deployments
* Fastify and Koa adapter wrappers (reuse Node SDK core)

## Ultimate Goals

#### Vendor Payment Rails
* A GitHub repo which a vendor simply pip installs / npm installs, drops a few lines of code, and it works.
  * Bots are blocked and told to pay
  * Payments are received to our wallet
    * For now, converting to cash and sending to vendors manually is fine
    * May even make sense to send them small amounts to improve word of mouth

#### Vendor UI
* A website where a vendor enters their bank details, verifies ownership of their resource

#### Agent Wallet
* A USDC/Solana wallet service for AI agents
* Demonstration to the ecosystem that agent-native payments work
* Likely harder technically than the core product for an MVP
