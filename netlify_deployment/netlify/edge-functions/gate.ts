import { createNetlifyGate } from "../../../sdk/netlify-gate.ts";

// Stripe-style integration target:
// thin wrapper only, shared gate logic lives in sdk/
export default createNetlifyGate();
