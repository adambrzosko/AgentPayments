import { createEdgeGate, InMemoryStore } from './index.js';
import { CloudflareKVStore } from './cloudflare-kv-store.js';

export { CloudflareKVStore } from './cloudflare-kv-store.js';

export function createAgentPaymentsWorker(options = {}) {
  const {
    assetsBinding = 'ASSETS',
    publicPathAllowlist = [],
    minPayment,
    accessDuration,
    pricingTiers,
    routes,
    powDifficulty,
    verifyCrawlers,
    requireHttps,
    // Name of the KV namespace binding in wrangler.toml (default: AGENTPAYMENTS_KV).
    // If the binding is present in env, a CloudflareKVStore is used — giving
    // cross-isolate nonce replay prevention, rate limiting, and payment caching.
    // If absent (local dev, binding not yet created), falls back to InMemoryStore.
    kvBinding = 'AGENTPAYMENTS_KV',
    // Optional override for the per-request store factory — e.g. to use
    // Durable Objects instead of KV. Defaults to the KV-or-memory behavior below.
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
    getClientIp: ({ request }) => request.headers.get('cf-connecting-ip') || 'unknown',
    fetchUpstream: (request, env) => {
      const binding = env[assetsBinding];
      if (!binding || typeof binding.fetch !== 'function') {
        return new Response(`${assetsBinding} binding is missing.`, { status: 500 });
      }
      return binding.fetch(request);
    },
    // Per-request store factory: use KV when bound, fall back to in-memory.
    getStore: getStore || (({ env }) => {
      const kv = env[kvBinding];
      return kv ? new CloudflareKVStore(kv) : new InMemoryStore();
    }),
  });

  return {
    fetch(request, env, context) {
      return gate(request, env, context);
    },
  };
}
