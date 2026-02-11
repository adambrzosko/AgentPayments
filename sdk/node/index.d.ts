import type { RequestHandler } from 'express';

export interface AgentPaymentsGateConfig {
  /** HMAC secret for signing agent keys and cookies. Required for production. */
  challengeSecret?: string;
  /** Solana wallet address to receive USDC payments. */
  homeWalletAddress?: string;
  /** Custom Solana RPC URL. Defaults to devnet/mainnet based on debug flag. */
  solanaRpcUrl?: string;
  /** Custom USDC mint address. Defaults to devnet/mainnet based on debug flag. */
  usdcMint?: string;
  /** Enable debug mode (devnet). Defaults to process.env.DEBUG !== 'false'. */
  debug?: boolean;
}

/**
 * Creates an Express middleware that gates access behind Solana USDC payments.
 *
 * Browser visitors see a JavaScript challenge page.
 * API clients (agents) must provide a valid, paid agent key via the X-Agent-Key header.
 *
 * @example
 * ```js
 * const { agentPaymentsGate } = require('@agentpayments/node');
 *
 * app.use(agentPaymentsGate({
 *   challengeSecret: process.env.CHALLENGE_SECRET,
 *   homeWalletAddress: process.env.HOME_WALLET_ADDRESS,
 * }));
 * ```
 */
export function agentPaymentsGate(config?: AgentPaymentsGateConfig): RequestHandler;
