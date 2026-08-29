import { createEdgeGate } from './index.js';

// Vercel adapter (Edge Middleware / Route Handler runtime).
// Caller provides upstreamNext() to return NextResponse.next() (or equivalent).
export function createVercelEdgeGate(options = {}) {
  const {
    publicPathAllowlist = [],
    minPayment,
    accessDuration,
    pricingTiers,
    routes,
    powDifficulty,
    verifyCrawlers,
    requireHttps,
    env = {},
    upstreamNext,
    getClientIp,
    // Optional durable state backend — Vercel has no built-in equivalent to
    // Cloudflare's KV binding, so bring your own Store implementation (e.g.
    // backed by Vercel KV, Upstash Redis) if you need cross-invocation rate
    // limiting / payment caching. Defaults to per-invocation InMemoryStore.
    store,
    getStore,
  } = options;

  if (typeof upstreamNext !== 'function') {
    throw new Error('createVercelEdgeGate requires upstreamNext(request)');
  }

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
    getClientIp: ({ request }) =>
      (getClientIp ? getClientIp(request) : request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()) || 'unknown',
    fetchUpstream: (request) => upstreamNext(request),
  });

  return (request) => gate(request, env, {});
}
