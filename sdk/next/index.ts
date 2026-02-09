import { NextResponse } from 'next/server';
import { createVercelEdgeGate } from '../edge/vercel.js';

type EnvConfig = {
  CHALLENGE_SECRET?: string;
  HOME_WALLET_ADDRESS?: string;
  SOLANA_RPC_URL?: string;
  USDC_MINT?: string;
  DEBUG?: string;
};

type Options = {
  env?: EnvConfig;
  publicPathAllowlist?: string[];
  minPayment?: number;
};

export function createNextMiddleware(options: Options = {}) {
  const env: EnvConfig = options.env || {
    CHALLENGE_SECRET: process.env.CHALLENGE_SECRET,
    HOME_WALLET_ADDRESS: process.env.HOME_WALLET_ADDRESS,
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
    USDC_MINT: process.env.USDC_MINT,
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
