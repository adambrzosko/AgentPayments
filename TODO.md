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
* ~~Get a paid Solana RPC provider~~ — Helius; confirmed it resolves the 429s public devnet RPC hit mid-session, documented in ROADMAP
* ~~Purge committed private keys from git history~~ — `jsons/wallet-keys.json`/`jsons/bot-wallet.json` removed from all history on `main`/`onchain-platform-fee`/`testsAndImprovements`, force-pushed to the public repo, verified clean
* ~~Prove the gate works on real mainnet~~ — live smoke test: real 0.01 USDC + memo transaction on Solana mainnet, verified via the deployed gate's own on-chain verification logic, access correctly granted (tx `66Fri43fJn2jwi3dCQRPPMwoQjiquAs3fohjhd6R4Z5wXn38MWb79sP2r7iqJcJoQezkBtnC6ro39KCGrj22hTG9`)
* ~~Republish the 3 SDK packages with the real `PLATFORM_API_URL` default~~ — `@agentpayments/node@0.1.1`, `@agentpayments/edge@0.1.1`, `agentpayments-python==0.1.1` all live, default now `api.agentpayments.cloud`; hosted-platform users no longer need to pass `platformApiUrl` explicitly
* ~~A live, no-install demo~~ — `demo/` deployed, live at `demo.agentpayments.cloud`, linked from the landing page nav + hero CTA. Real devnet-funded agent wallet plays the agent role for real: 402 → on-chain USDC + memo payment → retry → granted, streamed live over SSE. Along the way, found and documented a real bug in ROADMAP: Node's `fetch()` always sends a header `isBrowser()` treats as browser-proof, misclassifying real fetch()-based agents
* ~~Proxy adapter~~ — `sdk/proxy/` (`@agentpayments/proxy`): standalone reverse proxy for backends with no native SDK (any language/stack). Wraps the same `@agentpayments/node` gate logic; verified end-to-end against a real non-Node upstream (Python `http.server`) — unpaid requests never reach it, public paths pass through, a real devnet payment gets forwarded correctly. 3 automated tests passing
* ~~Comprehensive deployment test script~~ — `scripts/verify-deployments.js`: checks the landing site, API auth guard, live demo, and published npm/PyPI package versions; `--full` also runs a real devnet payment through the live demo end-to-end. Legacy demo URLs from the original upstream project are checked informationally, don't affect pass/fail
* ~~Fastify and Koa adapter wrappers~~ — `sdk/fastify/` (`@agentpayments/fastify`, via `@fastify/express`) and `sdk/koa/` (`@agentpayments/koa`, ctx adapted directly — `koa-connect` was tried first but passes Koa's raw req/res with no Express-style methods, so the gate crashed against it). Both wrap the exact, unmodified `@agentpayments/node` gate; each verified with a real devnet payment through a live test server (402 → challenge page → real on-chain payment → granted) plus automated tests
* ~~Fix `isBrowser()` misclassifying fetch()-based agents as browsers~~ — all three SDKs (`sdk/node`, `sdk/edge`, `sdk/python`) now require `Sec-Fetch-Mode: navigate` or `Sec-Fetch-Dest: document` specifically (top-level-navigation-only values), not mere presence of a Sec-Fetch header; see ROADMAP
* ~~Pricing & access model (self-hosted gate)~~ — all three SDKs gained `accessDuration`, `pricingTiers` (payment-amount → duration mapping), `routes` (per-path price overrides), and grant revocation (`grantStore.revoke()` / Edge's `invalidatePayment()`); Python's missing `min_payment` configurability closed along the way. Hosted-platform (`agp_`) per-key pricing/revocation deliberately deferred — see ROADMAP
* ~~Multi-process/multi-isolate state backends~~ — Python's rate limiters and payment cache were hardcoded module-level singletons with no way to plug in anything (a bigger gap than Node, which already had this); new `sdk/python/agentpayments_python/redis_store.py` mirrors `sdk/node/redis-store.js`, wired through all three adapters. Also fixed: `createAgentPaymentsWorker`/`createNetlifyGate`/`createVercelEdgeGate` were silently dropping `store`/`getStore` and the newer pricing options instead of passing them to `createEdgeGate` — see ROADMAP
* ~~Wire the test suites into CI~~ — `.github/workflows/ci.yml`'s Node/Edge/Python jobs only ran syntax/import checks before; every green PR checkmark reflected syntax validity, not the 48+29+137 tests actually passing. Added a real `node --test`/`npm test`/`pytest` step to each job, verified in the PR's own CI run (not just locally)
* ~~Balance-delta payment verification~~ — `verifyPaymentOnChain`'s remaining hardening item, closed: paid amount now comes from `preTokenBalances`/`postTokenBalances` (the actual balance change), not instruction parsing — token-program-agnostic, robust to nested CPI transfers and fee-on-transfer extensions. See ROADMAP
* ~~E2E + load test scripts~~ — `scripts/e2e-demo.js` (browser/agent-402/paid-key/public-path flows against the live demo, scheduled nightly) and `scripts/load-test.js` (local rate-limiter flood, offline). The E2E script's first run caught a real issue: `demo.agentpayments.cloud` needs a redeploy to pick up the isBrowser() fix — see ROADMAP
* ~~Improve bot communication~~ — ChatGPT and other LLM agents weren't reliably reading the 402 response instructions. Root cause confirmed and fixed: the `isBrowser()`/fetch() misclassification (see ROADMAP). `demo.agentpayments.cloud` was redeployed with the fix, then validated with Node's real global `fetch()` (the exact transport `langchain-core`'s `AsyncCaller.fetch()`, `openai-node`, and `anthropic-sdk-typescript` all use, unmodified, no manual header spoofing) — it now correctly receives the machine-readable 402 JSON instead of the HTML challenge page. `scripts/e2e-demo.js` passes 6/6 against the live demo

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
