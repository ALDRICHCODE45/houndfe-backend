'use strict';
// Explicit PO opt-in; importing either host is inert (offline-test safe).
const host = require('../supplier-runtime/host.cjs');
module.exports = host;
if (require.main === module) host.start({ po: true });
