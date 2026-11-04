'use strict';
// Explicit PO opt-in; importing either host is inert (offline-test safe).
// The O3c fixture (readable names, per-grant users, real-command orders) replaces
// the generic PO seed through the supplier host's fixture hook.
const host = require('../supplier-runtime/host.cjs');
const fixture = require('./po-fixture.cjs');
module.exports = { ...host, fixture };
if (require.main === module) host.start({ po: true, fixture });
