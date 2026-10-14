// Dedicated opt-in proof runner; does not load .env or the shared DB setup.
// The spec validates its disposable-only URL before constructing a client.
if (process.env.CASH_PROOF_DISPOSABLE !== '1') {
  throw new Error(
    'CASH_PROOF_DISPOSABLE=1 is required for the isolated cash proof runner',
  );
}
const unit = require('./jest.config.js');
module.exports = {
  ...unit,
  testRegex: '\\.cash-proof\\.integration\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 15000,
};
