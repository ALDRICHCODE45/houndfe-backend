/**
 * customers-bulk-actions / T3 (S5) — ZIP file name, per-customer entry names
 * (frontend L3.3: customer name, sanitized, disambiguated) and the business
 * wall clock used for the ZIP DOS timestamps.
 */
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

  it('works for another zone (UTC)', () => {
    const wall = businessWallClock(new Date('2026-01-02T03:04:05.000Z'), 'UTC');
    expect([wall.getDate(), wall.getHours(), wall.getMinutes()]).toEqual([
      2, 3, 4,
    ]);
  });
});
