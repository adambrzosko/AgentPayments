# @agentpayments/proxy

A standalone reverse proxy that gates any backend — any language, any stack — behind Solana USDC payments. No SDK, no code changes to your app: point this in front of it.

Use this instead of `@agentpayments/node`/`@agentpayments/edge`/`agentpayments-python` when your backend isn't Node or Python (PHP, Ruby, Go, a static site, a legacy app you don't want to touch), or when you'd rather enforce payment at the infrastructure layer (an Nginx/Envoy-style sidecar) than in application code.

## How it works

```
Agent/browser → @agentpayments/proxy → your backend (any language)
```

Every request hits the proxy first. It runs the exact same gate logic as the Node SDK — public paths pass through, verified browsers pass through, agents with a paid key pass through — and only forwards a request to your real backend (`UPSTREAM_URL`) once it's cleared the gate. An unpaid request never reaches your app at all.

## Install & run

```bash
npm install -g @agentpayments/proxy
UPSTREAM_URL=http://localhost:4000 \
CHALLENGE_SECRET=your-secret \
HOME_WALLET_ADDRESS=your-solana-wallet \
agentpayments-proxy
```

Or run it from source in this monorepo:

```bash
cd sdk/proxy
npm install
UPSTREAM_URL=http://localhost:4000 CHALLENGE_SECRET=... HOME_WALLET_ADDRESS=... npm start
```

## Docker

```bash
docker build -t agentpayments-proxy sdk/proxy
docker run -p 8080:8080 \
  -e UPSTREAM_URL=http://your-backend:4000 \
  -e CHALLENGE_SECRET=your-secret \
  -e HOME_WALLET_ADDRESS=your-solana-wallet \
  agentpayments-proxy
```

Point your load balancer / DNS at the proxy instead of your backend directly. In a Docker Compose or Kubernetes setup, run it as a sidecar in front of the real service.

## Configuration

All configuration is via environment variables (this runs as a standalone process, not an imported library):

| Variable | Required | Description |
|---|---|---|
| `UPSTREAM_URL` | **yes** | The real backend to forward verified traffic to, e.g. `http://localhost:4000`. |
| `CHALLENGE_SECRET` | production | HMAC secret for signing cookies, nonces, and agent keys. |
| `HOME_WALLET_ADDRESS` | yes | Solana wallet address to receive USDC payments. |
| `SOLANA_RPC_URL` | no | Custom Solana RPC endpoint (recommended in production — see the main README's RPC guidance). |
| `USDC_MINT` | no | Custom USDC mint address. Defaults to the standard devnet/mainnet mint. |
| `DEBUG` | no | `false` in production (mainnet + strict). Defaults to devnet mode. |
| `AGENTPAYMENTS_API_KEY` | no | Hosted-platform API key (`ap_live_...`) — see the Node SDK README's Hosted Platform Mode section; identical behavior here. |
| `AGENTPAYMENTS_PLATFORM_URL` | no | Override for a self-hosted platform API. |
| `PORT` | no | Defaults to `8080`. |
| `HOST` | no | Defaults to `0.0.0.0`. |
| `TRUST_PROXY` | no | Defaults to `true` — set `false` if this proxy is directly internet-facing with no reverse proxy of its own in front. |

## What's forwarded

WebSocket upgrades are proxied too (`ws: true`), so this works in front of apps that use them. `changeOrigin: true` is always on, so your backend sees requests as if they came directly to `UPSTREAM_URL`.

## Notes

- Built on `@agentpayments/node` — same gate logic, same security properties, same 402/x402 response format. See the [API Reference](../../API_REFERENCE.md).
- This is the right choice when you can't (or don't want to) add SDK middleware to your app's own code. If your backend is Node or Python, the native SDK avoids the extra network hop.
