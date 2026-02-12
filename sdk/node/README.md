# @agentpayments/node (local SDK package)

Express-first AgentPayments middleware.

## Integration shape

```js
const express = require('express');
const { agentPaymentsGate } = require('@agentpayments/node');

const app = express();
app.use(express.urlencoded({ extended: false }));

app.use(agentPaymentsGate({
  challengeSecret: process.env.CHALLENGE_SECRET,
  verifyUrl: process.env.AGENTPAYMENTS_VERIFY_URL,
  apiKey: process.env.AGENTPAYMENTS_API_KEY,
}));
```

`AGENTPAYMENTS_VERIFY_URL` accepts either:
- verify endpoint: `https://verify.example.com/verify`
- base service URL: `https://verify.example.com` (the SDK will append `/verify`)

## Notes
- Wallet address and network are fetched automatically from the verify service.
- This is implementation #1 of the 80/20 roadmap.
- Current target runtime: Node/Express.
- Next wrappers to add later: Fastify and Koa (same core behavior).
