import { createAgentPaymentsWorker } from '../../../sdk/edge/cloudflare.js';

// Stripe-style integration target:
// this file should stay as tiny wiring code + config.
export default createAgentPaymentsWorker({
  assetsBinding: 'ASSETS',
  publicPathAllowlist: [],
  minPayment: 0.01,
});
