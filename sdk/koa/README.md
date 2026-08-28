# @agentpayments/koa

AgentPayments gate for Koa. Same behavior, same security properties, same response format as `@agentpayments/node` — this package doesn't reimplement any gate logic, it adapts Koa's `ctx` to the small Express-like req/res surface the gate actually uses and calls the exact, unmodified middleware through it.

## Install

```bash
npm install @agentpayments/koa koa
```

## Usage

```js
const Koa = require('koa');
const { agentPaymentsKoa } = require('@agentpayments/koa');

const app = new Koa();

app.use(agentPaymentsKoa({
  challengeSecret: process.env.CHALLENGE_SECRET,
  homeWalletAddress: process.env.HOME_WALLET_ADDRESS,
}));

app.use((ctx) => {
  ctx.body = { message: 'Hello, verified visitor!' };
});

app.listen(3000);
```

## Configuration

Same options as [`@agentpayments/node`](../node/README.md#configuration) — `challengeSecret`, `homeWalletAddress`, `solanaRpcUrl`, `usdcMint`, `debug`, `apiKey`, `platformApiUrl`.

## How it works

Koa's `ctx` already exposes near-identical methods to what the gate needs (`ctx.get()`, `ctx.set()`, `ctx.path`, `ctx.secure`, `ctx.cookies.set()`), so this package maps `ctx` directly to the req/res shape `@agentpayments/node`'s gate touches, rather than going through Koa's raw `ctx.req`/`ctx.res` (which are bare Node HTTP objects with none of those methods). The one piece of custom logic is parsing the `application/x-www-form-urlencoded` body for the internal `/__challenge/verify` endpoint, since Koa doesn't parse request bodies by default — everything else defers straight to the unmodified gate. See the [Node SDK README](../node/README.md#how-it-works) and the [API Reference](../../API_REFERENCE.md) for the full behavior.

## Notes

- Requires `koa` ^2 or ^3 as a peer dependency.
- CommonJS module (`require()`).
