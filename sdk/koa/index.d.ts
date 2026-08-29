import type { Middleware } from 'koa';
import type { AgentPaymentsGateConfig } from '@agentpayments/node';

export function agentPaymentsKoa(config?: AgentPaymentsGateConfig): Middleware;
