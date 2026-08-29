import { createEdgeGate } from './index.js';

export function createNetlifyGate(options = {}) {
  const {
    publicPathAllowlist = [],
    minPayment,
    accessDuration,
    pricingTiers,
    routes,
    powDifficulty,
    verifyCrawlers,
    requireHttps,
    // Optional durable state backend — Netlify has no built-in equivalent to
    // Cloudflare's KV binding, so bring your own Store implementation (e.g.
    // backed by Netlify Blobs, Upstash Redis) if you need cross-invocation
    // rate limiting / payment caching. Defaults to per-invocation InMemoryStore.
    store,
    getStore,
  } = options;

  const gate = createEdgeGate({
    publicPathAllowlist,
    minPayment,
    accessDuration,
    pricingTiers,
    routes,
    powDifficulty,
    verifyCrawlers,
    requireHttps,
    store,
    getStore,
    getClientIp: ({ context }) => context?.ip || 'unknown',
    envResolver: () => ({
      CHALLENGE_SECRET: Deno.env.get('CHALLENGE_SECRET') || 'default-secret-change-me',
      HOME_WALLET_ADDRESS: Deno.env.get('HOME_WALLET_ADDRESS') || '',
      SOLANA_RPC_URL: Deno.env.get('SOLANA_RPC_URL') || '',
      USDC_MINT: Deno.env.get('USDC_MINT') || '',
      DEBUG: Deno.env.get('DEBUG') || '',
      AGENTPAYMENTS_API_KEY: Deno.env.get('AGENTPAYMENTS_API_KEY') || '',
      AGENTPAYMENTS_PLATFORM_URL: Deno.env.get('AGENTPAYMENTS_PLATFORM_URL') || '',
    }),
    fetchUpstream: (request, _env, context) => context.next(request),
  });

  return (request, context) => gate(request, {}, context);
}
