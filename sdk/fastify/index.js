/**
 * AgentPayments gate for Fastify.
 *
 * Registers @fastify/express (the officially maintained Express-compat
 * layer) and mounts the exact, unmodified @agentpayments/node middleware
 * through it — same gate behavior, same security properties, same
 * response format as the Express SDK. No gate logic is reimplemented here.
 */
'use strict';

const fp = require('fastify-plugin');
const fastifyExpress = require('@fastify/express');
const { agentPaymentsGate } = require('@agentpayments/node');

async function agentPaymentsFastifyPlugin(fastify, opts) {
  await fastify.register(fastifyExpress);
  fastify.use(agentPaymentsGate(opts));
}

const agentPaymentsFastify = fp(agentPaymentsFastifyPlugin, {
  name: '@agentpayments/fastify',
});

module.exports = { agentPaymentsFastify };
