export interface EdgeGateOptions {
  /**
   * Function to fetch the upstream/origin response.
   * Called when a request passes the gate (browser verified or agent paid).
   */
  fetchUpstream: (request: Request, env: Record<string, string>, context: unknown) => Response | Promise<Response>;
  /**
   * Function to extract the client IP from the request context.
   * Defaults to returning 'unknown'.
   */
  getClientIp?: (ctx: { request: Request; env: Record<string, string>; context: unknown }) => string;
  /** Paths that bypass the gate entirely (e.g., health checks). */
  publicPathAllowlist?: string[];
  /** Minimum USDC payment amount. Defaults to 0.01. */
  minPayment?: number;
  /**
   * Async function to resolve environment variables per-request.
   * Useful for platforms where env is passed per-request (e.g., Cloudflare Workers).
   */
  envResolver?: (ctx: { request: Request; env: Record<string, string>; context: unknown }) => Record<string, string> | Promise<Record<string, string>>;
}

/**
 * Creates an edge gate handler for Cloudflare Workers, Netlify Edge, and similar runtimes.
 *
 * @example
 * ```js
 * import { createEdgeGate } from '@agentpayments/edge';
 *
 * const gate = createEdgeGate({
 *   fetchUpstream: (request, env) => env.ASSETS.fetch(request),
 *   getClientIp: ({ request }) => request.headers.get('cf-connecting-ip') || 'unknown',
 * });
 *
 * export default { fetch: (req, env, ctx) => gate(req, env, ctx) };
 * ```
 */
export function createEdgeGate(options: EdgeGateOptions): (
  request: Request,
  env?: Record<string, string>,
  context?: unknown,
) => Promise<Response>;
