/**
 * customers-bulk-actions / T3 (S5) — ZIP file name, per-customer entry names
 * (frontend L3.3: customer name, sanitized, disambiguated) and the business
 * wall clock used for the ZIP DOS timestamps.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  allocateStatementEntryNames,
  buildBulkStatementsZipFilename,
  businessWallClock,
  customerStatementDisplayName,
} from './customer-bulk-statements.naming';

const ID_A = '3f2a9c1e-0000-4000-8000-000000000001';
const ID_B = '7b1d2e3f-0000-4000-8000-000000000002';
const ID_C = 'a1b2c3d4-0000-4000-8000-000000000003';

describe('customerStatementDisplayName', () => {
  it('first + last name, trimmed', () => {
    expect(
      customerStatementDisplayName({
        id: ID_A,
        firstName: '  Ana ',
        lastName: ' López ',
      }),
    ).toBe('Ana López');
  });

  it('first name alone when the last name is blank or null', () => {
    expect(
      customerStatementDisplayName({
        id: ID_A,
        firstName: 'Luis',
        lastName: '  ',
      }),
    ).toBe('Luis');
    expect(
      customerStatementDisplayName({
        id: ID_A,
        firstName: 'Luis',
        lastName: null,
      }),
    ).toBe('Luis');
  });
});

describe('allocateStatementEntryNames', () => {
  it('one `<name>.pdf` per customer, accents kept, invalid characters replaced', () => {
    expect(
      allocateStatementEntryNames([
        { id: ID_A, firstName: 'José', lastName: 'Ñúñez' },
        { id: ID_B, firstName: 'A/B', lastName: 'C:D*?' },
      ]),
    ).toEqual(['José Ñúñez.pdf', 'A-B C-D--.pdf']);
  });

  it('equal names are disambiguated in input order: (2), (3); case-insensitive', () => {
    expect(
      allocateStatementEntryNames([
        { id: ID_A, firstName: 'Ana', lastName: 'López' },
        { id: ID_B, firstName: 'ana', lastName: 'lópez' },
        { id: ID_C, firstName: 'Ana', lastName: 'López' },
      ]),
    ).toEqual(['Ana López.pdf', 'ana lópez (2).pdf', 'Ana López (3).pdf']);
  });

  it('a name with nothing usable falls back to `cliente-<id8>`', () => {
    expect(
      allocateStatementEntryNames([
        { id: ID_A, firstName: '...', lastName: null },
        { id: ID_B, firstName: '\u200b', lastName: '' },
      ]),
    ).toEqual(['cliente-3f2a9c1e.pdf', 'cliente-7b1d2e3f.pdf']);
  });

  it('caps the name at 100 characters, and keeps a collision suffix within the cap', () => {
    const long = 'A'.repeat(120);
    const names = allocateStatementEntryNames([
      { id: ID_A, firstName: long, lastName: null },
      { id: ID_B, firstName: long, lastName: 'Zeta' },
      { id: ID_C, firstName: long, lastName: null },
    ]);
    // The second one differs only past the cap, so it collides too.
    expect(names).toEqual([
      `${'A'.repeat(100)}.pdf`,
      `${'A'.repeat(96)} (2).pdf`,
      `${'A'.repeat(96)} (3).pdf`,
    ]);
    for (const name of names) {
      expect(Array.from(name.replace(/\.pdf$/, '')).length).toBeLessThanOrEqual(
        100,
      );
    }
  });

  it('counts the cap in characters (accents, ñ, emoji), not bytes', () => {
    const [name] = allocateStatementEntryNames([
      { id: ID_A, firstName: 'Ñ'.repeat(150), lastName: null },
    ]);
    expect(name).toBe(`${'Ñ'.repeat(100)}.pdf`);
  });

  it('the cut at 100 never leaves a trailing space or dot before `.pdf`', () => {
    // Character 100 is a space, 99 a dot.
    const name = `${'B'.repeat(98)}. Apellido`;
    const [entry] = allocateStatementEntryNames([
      { id: ID_A, firstName: name, lastName: null },
    ]);
    expect(entry).toBe(`${'B'.repeat(98)}.pdf`);
  });

  it('trailing / leading dots and spaces are trimmed (no `Ana..pdf`, no hidden `.Ana.pdf`)', () => {
    expect(
      allocateStatementEntryNames([
        { id: ID_A, firstName: 'Ana.', lastName: null },
        { id: ID_B, firstName: ' . Bruno ', lastName: 'Ruiz. . ' },
        { id: ID_C, firstName: 'Ana', lastName: '...' },
      ]),
    ).toEqual(['Ana.pdf', 'Bruno Ruiz.pdf', 'Ana (2).pdf']);
  });

  it('never yields a path separator or `..` segment', () => {
    const [name] = allocateStatementEntryNames([
      { id: ID_A, firstName: '../../etc', lastName: 'passwd' },
    ]);
    expect(name).not.toMatch(/[\\/]/);
    expect(name.startsWith('.')).toBe(false);
  });
});

describe('buildBulkStatementsZipFilename', () => {
  it('estados-de-cuenta-<from>-<to>.zip', () => {
    expect(
      buildBulkStatementsZipFilename({ from: '2026-11-01', to: '2026-12-01' }),
    ).toBe('estados-de-cuenta-2026-11-01-2026-12-01.zip');
  });

  it('re-sanitizes every component (header-safe)', () => {
    expect(
      buildBulkStatementsZipFilename({
        from: '2026-11-01"\r\n',
        to: '../2026-12-01',
      }),
    ).toBe('estados-de-cuenta-2026-11-01-2026-12-01.zip');
  });
});

describe('businessWallClock', () => {
  it('local getters of the result show the business wall time (Mexico City, UTC-6)', () => {
    const wall = businessWallClock(
      new Date('2026-11-27T05:59:30.000Z'),
      'America/Mexico_City',
    );
    expect([
      wall.getFullYear(),
      wall.getMonth() + 1,
      wall.getDate(),
      wall.getHours(),
      wall.getMinutes(),
      wall.getSeconds(),
    ]).toEqual([2026, 11, 26, 23, 59, 30]);
  });

  /**
   * R3 wall clock: the ZIP writer encodes DOS timestamps from LOCAL getters,
   * so the result must not depend on the server time zone. Jest sandboxes
   * `process.env`, so `TZ` cannot be switched in-process: a child Node runs
   * the real `businessWallClock` + `toDosDateTime` under several server
   * zones (real `process.env.TZ` switching there).
   */
  describe('whatever the server time zone is (R3 wall clock)', () => {
    type Fields = [number, number, number, number, number, number];
    const SERVER_ZONES = [
      'UTC',
      'Asia/Tokyo',
      'America/New_York',
      'Europe/Madrid',
      'Pacific/Kiritimati',
    ];
    const INSTANTS = {
      // 2026-11-27 10:15:20 in Mexico City.
      normal: '2026-11-27T16:15:20.000Z',
      // 01:30 Mexico City = inside New York's repeated fall-back hour.
      nyFallBack: '2026-11-01T07:30:00.000Z',
      // 02:30 Mexico City = inside New York's spring-forward gap.
      nyGap: '2026-03-08T08:30:00.000Z',
    };
    let results: Record<string, Record<string, Fields>>;

    beforeAll(() => {
      const script = `
        const { businessWallClock } = require('./src/sales/customer-bulk-statements.naming');
        const { toDosDateTime } = require('./src/shared/zip');
        const zones = ${JSON.stringify(SERVER_ZONES)};
        const instants = ${JSON.stringify(INSTANTS)};
        const out = {};
        for (const zone of zones) {
          process.env.TZ = zone;
          out[zone] = {};
          for (const [key, iso] of Object.entries(instants)) {
            const { date, time } = toDosDateTime(businessWallClock(new Date(iso), 'America/Mexico_City'));
            out[zone][key] = [(date >> 9) + 1980, (date >> 5) & 15, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2];
          }
          out[zone].offsetCheck = [new Date('2026-07-01T00:00:00Z').getTimezoneOffset(), 0, 0, 0, 0, 0];
        }
        process.stdout.write(JSON.stringify(out));
      `;
      const stdout = execFileSync(
        process.execPath,
        ['-r', 'ts-node/register', '-e', script],
        {
          cwd: join(__dirname, '..', '..'),
          env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', TZ: 'UTC' },
        },
      ).toString();
      results = JSON.parse(stdout) as typeof results;
    }, 60_000);

    it('the child really switched the server zone (sanity)', () => {
      expect(results['UTC'].offsetCheck[0]).toBe(0);
      expect(results['Asia/Tokyo'].offsetCheck[0]).toBe(-540);
      expect(results['America/New_York'].offsetCheck[0]).toBe(240);
    });

    it.each(SERVER_ZONES)(
      'server TZ %s: the ZIP DOS timestamp is the Mexico City wall time',
      (zone) => {
        expect(results[zone].normal).toEqual([2026, 11, 27, 10, 15, 20]);
      },
    );

    it('server TZ with DST: the repeated fall-back hour keeps the business wall time', () => {
      expect(results['America/New_York'].nyFallBack).toEqual([
        2026, 11, 1, 1, 30, 0,
      ]);
    });

    it.each(SERVER_ZONES.filter((zone) => zone !== 'America/New_York'))(
      'server TZ %s (no gap at that moment): exact business wall time',
      (zone) => {
        expect(results[zone].nyGap).toEqual([2026, 3, 8, 2, 30, 0]);
      },
    );

    it('known limit: a business wall time inside the server spring-forward gap does not exist locally; it is shifted forward by the gap (documented)', () => {
      expect(results['America/New_York'].nyGap).toEqual([2026, 3, 8, 3, 30, 0]);
    });
  });

  it('works for another zone (UTC)', () => {
    const wall = businessWallClock(new Date('2026-01-02T03:04:05.000Z'), 'UTC');
    expect([wall.getDate(), wall.getHours(), wall.getMinutes()]).toEqual([
      2, 3, 4,
    ]);
  });
});
