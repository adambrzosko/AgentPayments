# @agentpayments/fastify

AgentPayments gate for Fastify. Same behavior, same security properties, same response format as `@agentpayments/node` — this package doesn't reimplement any gate logic, it wires the exact, unmodified Express middleware into Fastify via [`@fastify/express`](https://github.com/fastify/fastify-express), the officially maintained Express-compat layer.

## Install

```bash
npm install @agentpayments/fastify fastify
```

## Usage

```js
const Fastify = require('fastify');
const { agentPaymentsFastify } = require('@agentpayments/fastify');

const fastify = Fastify();

fastify.register(agentPaymentsFastify, {
  challengeSecret: process.env.CHALLENGE_SECRET,
  homeWalletAddress: process.env.HOME_WALLET_ADDRESS,
});

fastify.get('/', async (req, reply) => {
  return { message: 'Hello, verified visitor!' };
});

fastify.listen({ port: 3000 });
```

## Configuration

Same options as [`@agentpayments/node`](../node/README.md#configuration) — `challengeSecret`, `homeWalletAddress`, `solanaRpcUrl`, `usdcMint`, `debug`, `apiKey`, `platformApiUrl` — passed straight through as the plugin's `opts`.

## How it works

`fastify.register(agentPaymentsFastify, opts)` registers `@fastify/express` (which embeds a real Express instance) and mounts `agentPaymentsGate(opts)` on it via `fastify.use()`. Every request Fastify receives passes through the gate exactly as it would in a plain Express app — same 402/x402 response format, same challenge page, same on-chain verification. See the [Node SDK README](../node/README.md#how-it-works) and the [API Reference](../../API_REFERENCE.md) for the full behavior.

## Notes

- Requires `fastify` ^4 or ^5 as a peer dependency.
- CommonJS module (`require()`).
