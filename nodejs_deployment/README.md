# Node.js Deployment (Test Website)

Vanilla customer-style Express app that shows plug-and-play AgentPayments wiring.

## Run

```bash
cd nodejs_deployment
cp .env.example .env
npm install
npm start
```

## Integration shape

This demo intentionally keeps gate logic out of app code.
It only shows middleware wiring:

```js
const { agentPaymentsGate } = require('@agentpayments/node');
app.use(agentPaymentsGate(config));
```

In this repo, `./lib/agentpayments-middleware` is a thin wrapper that imports shared gate logic from local package folder `../sdk/node` (representing `@agentpayments/node`).

Deployment folder stays minimal; shared bot-blocking logic lives in `sdk/`.
