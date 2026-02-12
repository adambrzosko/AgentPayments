import { NextResponse } from 'next/server';
import { createVercelEdgeGate } from '../edge/vercel.js';

export function createNextMiddleware(options = {}) {
  const env = options.env || {
    CHALLENGE_SECRET: process.env.CHALLENGE_SECRET,
    HOME_WALLET_ADDRESS: process.env.HOME_WALLET_ADDRESS,
    AGENTPAYMENTS_VERIFY_URL: process.env.AGENTPAYMENTS_VERIFY_URL,
    AGENTPAYMENTS_API_KEY: process.env.AGENTPAYMENTS_API_KEY,
    DEBUG: process.env.DEBUG,
  };

  return createVercelEdgeGate({
    env,
    publicPathAllowlist: options.publicPathAllowlist || [],
    minPayment: options.minPayment,
    upstreamNext: () => NextResponse.next(),
    getClientIp: (request) =>
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown',
  });
}
