/**
 * Explicit live suite: pnpm test:live (serial).
 * Reuse offline transforms/roots/exclusions, removing ONLY the live ignore.
 * Never load dotenv or integration setup: each spec must admit an explicit
 * EDITORIAL_COORDINATION_PG_BINDING before constructing clients/importing apps.
 * Missing binding fails closed; this command does not authorize a DB target.
 */
const unit = require('./jest.config.js');

module.exports = {
  ...unit,
  testRegex: '.*\\.live\\.spec\\.ts$',
  testPathIgnorePatterns: unit.testPathIgnorePatterns.filter(
    (pattern) => pattern !== '\\.live\\.spec\\.ts$',
  ),
};
