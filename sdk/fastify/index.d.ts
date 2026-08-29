import type { FastifyPluginCallback } from 'fastify';
import type { AgentPaymentsGateConfig } from '@agentpayments/node';

export const agentPaymentsFastify: FastifyPluginCallback<AgentPaymentsGateConfig>;
