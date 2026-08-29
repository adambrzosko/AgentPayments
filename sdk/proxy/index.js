#!/usr/bin/env node
/**
 * AgentPayments standalone reverse proxy.
 *
 * For stacks with no native AgentPayments SDK (PHP, Ruby, Go, a static
 * file server, anything) — run this in front of the real backend instead
 * of installing a language-specific middleware. Every request is gated by
 * the same @agentpayments/node logic used by the Node SDK; only requests
 * that pass (public paths, verified browsers, paid agent keys) get
 * forwarded upstream. The real backend never sees an unpaid request.
 */
'use strict';

const http = require('node:http');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { agentPaymentsGate } = require('@agentpayments/node');

function buildApp({ upstreamUrl = process.env.UPSTREAM_URL } = {}) {
  if (!upstreamUrl) {
    throw new Error('UPSTREAM_URL is required — the backend this proxy forwards verified traffic to.');
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY !== 'false');

  app.use(agentPaymentsGate({
    challengeSecret: process.env.CHALLENGE_SECRET,
    homeWalletAddress: process.env.HOME_WALLET_ADDRESS,
    solanaRpcUrl: process.env.SOLANA_RPC_URL,
    usdcMint: process.env.USDC_MINT,
    debug: process.env.DEBUG !== 'false',
    apiKey: process.env.AGENTPAYMENTS_API_KEY || null,
    platformApiUrl: process.env.AGENTPAYMENTS_PLATFORM_URL,
  }));

  // Anything that reaches here has passed the gate — forward it untouched.
  const proxy = createProxyMiddleware({
    target: upstreamUrl,
    changeOrigin: true,
    ws: true,
    logger: console,
  });
  app.use(proxy);

  return { app, proxy };
}

if (require.main === module) {
  const PORT = Number.parseInt(process.env.PORT || '8080', 10);
  const HOST = process.env.HOST || '0.0.0.0';

  let app;
  let proxy;
  try {
    ({ app, proxy } = buildApp());
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const server = http.createServer(app);
  server.on('upgrade', proxy.upgrade);
  server.listen(PORT, HOST, () => {
    console.log(`AgentPayments proxy listening on http://${HOST}:${PORT} → ${process.env.UPSTREAM_URL}`);
  });
}

module.exports = { buildApp };
