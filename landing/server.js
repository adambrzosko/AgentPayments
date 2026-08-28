/**
 * AgentPayments marketing site — static file server.
 */
'use strict';

const express = require('express');
const path = require('node:path');

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

if (require.main === module) {
  const PORT = process.env.PORT || 3002;
  app.listen(PORT, () => console.log(`AgentPayments landing site listening on port ${PORT}`));
}

module.exports = { app };
