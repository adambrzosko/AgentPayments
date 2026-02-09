import { createNetlifyGate } from '../../../sdk/edge/netlify.js';

// Stripe-style integration target:
// thin wrapper only, shared gate logic lives in sdk/
export default createNetlifyGate();
