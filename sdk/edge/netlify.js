import { createEdgeGate } from './index.js';

export function createNetlifyGate(options = {}) {
  const { publicPathAllowlist = [], minPayment } = options;

  const gate = createEdgeGate({
    publicPathAllowlist,
    minPayment,
    getClientIp: ({ context }) => context?.ip || 'unknown',
    envResolver: () => ({
      CHALLENGE_SECRET: Deno.env.get('CHALLENGE_SECRET') || 'default-secret-change-me',
      HOME_WALLET_ADDRESS: Deno.env.get('HOME_WALLET_ADDRESS') || '',
      AGENTPAYMENTS_VERIFY_URL: Deno.env.get('AGENTPAYMENTS_VERIFY_URL') || '',
      AGENTPAYMENTS_GATE_SECRET: Deno.env.get('AGENTPAYMENTS_GATE_SECRET') || '',
      DEBUG: Deno.env.get('DEBUG') ?? 'true',
    }),
    fetchUpstream: (request, _env, context) => context.next(request),
  });

  return (request, context) => gate(request, {}, context);
}
