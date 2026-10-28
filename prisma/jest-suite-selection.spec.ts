import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const unit = require('../jest.config.js');
const integration = require('../jest.integration.config.js');

function listTests(config: string): string[] {
  // Discovery only: Jest does not execute specs or integration setup hooks.
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve(root, 'node_modules/jest/bin/jest.js'),
        '--config', config, '--runInBand', '--no-cache', '--listTests', '--json',
      ],
      { cwd: root, encoding: 'utf8', timeout: 10000 },
    ),
  ) as string[];
}

describe('public Jest suite selection', () => {
  it('keeps ordinary tests offline and all existing DB exclusions intact', () => {
    const offline = listTests('jest.config.js');
    expect(offline).toContain(__filename);
    expect(offline).toContain(resolve(root, 'src/promotions/application/evaluate-cart-sale-parity.spec.ts'));
    expect(offline.some((path) => path.endsWith('.live.spec.ts'))).toBe(false);
    expect(offline.some((path) => path.endsWith('.integration.spec.ts'))).toBe(false);
    for (const name of ['tenant-isolation', 'e4-concurrent-stock-alert', 'promotions-in-sale-migration-up-down']) {
      expect(offline.some((path) => path.endsWith(`/${name}.spec.ts`))).toBe(false);
    }
    const db = listTests('jest.integration.config.js');
    expect(db.length).toBeGreaterThan(0);
    expect(db).not.toContain(__filename);
    expect(db.some((path) => path.endsWith('.live.spec.ts'))).toBe(false);
    for (const name of ['tenant-isolation', 'e4-concurrent-stock-alert', 'promotions-in-sale-migration-up-down']) {
      expect(db.some((path) => path.endsWith(`/${name}.spec.ts`))).toBe(true);
    }
    expect(db.every((path) => path.endsWith('.integration.spec.ts') || /\/(tenant-isolation|e4-concurrent-stock-alert|promotions-in-sale-migration-up-down)\.spec\.ts$/.test(path))).toBe(true);
  });

  it('selects exactly the live suites excluded from offline discovery', () => {
    const live = listTests('jest.live.config.js');
    const offline = listTests('jest.config.js');
    expect(live).toHaveLength(5);
    expect(live.every((path) => path.endsWith('.live.spec.ts'))).toBe(true);
    expect(live.every((path) => !offline.includes(path))).toBe(true);
    expect(live.every((path) => /\/(src|prisma)\//.test(path.slice(root.length)))).toBe(true);
  });

  it('inherits unit settings except live selection, without implicit environment or setup', () => {
    const live = require('../jest.live.config.js');
    const { testRegex: _regex, testPathIgnorePatterns: _ignore, ...shared } = unit;
    const { testRegex: _liveRegex, testPathIgnorePatterns: liveIgnore, ...liveShared } = live;
    expect(liveShared).toEqual(shared);
    expect(liveIgnore).toEqual(unit.testPathIgnorePatterns.filter((pattern: string) => pattern !== '\\.live\\.spec\\.ts$'));
    for (const config of [unit, live]) {
      expect(config.setupFiles ?? []).toEqual([]);
      expect(config.setupFilesAfterEnv ?? []).toEqual([]);
      expect(config.globalSetup).toBeUndefined();
      expect(config.globalTeardown).toBeUndefined();
    }
    expect(integration.setupFiles).toEqual(['<rootDir>/test/integration/setup/load-env.ts']);
    expect(integration.globalSetup).toBe('<rootDir>/test/integration/setup/global-setup.ts');
    expect(require('../package.json').scripts['test:live']).toBe('jest --config jest.live.config.js --runInBand');
  });
});
