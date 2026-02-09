function agentPaymentsGate(_config = {}) {
  // Demo stub: pass-through middleware.
  // Real behavior will come from the published AgentPayments library.
  return function agentPaymentsGateMiddleware(_req, _res, next) {
    next();
  };
}

module.exports = {
  agentPaymentsGate,
};
