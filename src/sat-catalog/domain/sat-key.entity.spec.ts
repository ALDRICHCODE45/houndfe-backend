/**
 * Slice B — SAT catalog domain entity tests.
 *
 * Covers spec scenarios in tasks B.1.1, B.1.2, B.1.4:
 *   - `SatKey.create` runs the same `normalize()` as ingest so query and stored
 *     `searchText` stay byte-identical.
 *   - ñ-preservation anchor (W1): `niño` → `niño` (NOT `nino`); `piña` and
 *     `pina` are distinct; other diacritics stripped + lowercased.
 *   - `isActive(now)`: validTo === null → true; validTo < now → false;
 *     validTo > now → true.
 *
 * Pure-function tests, no DB.
 */
import { SatKey } from './sat-key.entity';

const BASE = {
  key: '01010101',
  description: 'Aspirina',
  includeIva: 'REQUIRED' as const,
  includeIeps: 'NONE' as const,
  validFrom: null,
  validTo: null,
};

describe('SatKey — create (B.1.1 / B.1.2 / B.1.3)', () => {
  it('builds searchText via normalize(key + " " + description)', () => {
    const sk = SatKey.create(BASE);

    // matches the spec invariant: `searchText.startsWith(key)`
    expect(sk.searchText.startsWith(BASE.key)).toBe(true);
    // normalized lowercased + accent-stripped
    expect(sk.searchText).toContain('aspirina');
    expect(sk.searchText).toBe('01010101 aspirina');
  });

  it('strips diacritics and lowercases the description: "Medicación" → "medicacion"', () => {
    const sk = SatKey.create({
      ...BASE,
      key: '01010103',
      description: 'Medicación',
    });

    expect(sk.searchText).toContain('01010103');
    expect(sk.searchText).toContain('medicacion');
    expect(sk.searchText).not.toContain('Medicación');
    // confirms the trailing space + accented form did not survive
    expect(sk.searchText).not.toContain('ón ');
    expect(sk.searchText).not.toContain('MEDIC');
  });

  it('preserves ñ end-to-end — ñ-preservation anchor (W1)', () => {
    const sk = SatKey.create({
      ...BASE,
      key: '01010104',
      description: 'Diseño niño piña',
    });

    expect(sk.searchText).toContain('niño');
    expect(sk.searchText).toContain('piña');
    expect(sk.searchText).not.toContain('nino');
    expect(sk.searchText).not.toContain('pina');
  });

  it('keeps "piña" and "pina" distinct substrings (no cross-collapse)', () => {
    const a = SatKey.create({
      ...BASE,
      key: '01010110',
      description: 'Piña fresca',
    });
    const b = SatKey.create({
      ...BASE,
      key: '01010111',
      description: 'Pina fresca',
    });

    expect(a.searchText).toContain('piña');
    expect(a.searchText).not.toContain('pina');
    expect(b.searchText).toContain('pina');
    expect(b.searchText).not.toContain('piña');
    // the two must NOT be byte-identical
    expect(a.searchText).not.toBe(b.searchText);
  });

  it('copies includeIva / includeIeps / validFrom / validTo as-is', () => {
    const validFrom = new Date('2018-01-01T00:00:00.000Z');
    const validTo = new Date('2030-12-31T00:00:00.000Z');

    const sk = SatKey.create({
      ...BASE,
      includeIva: 'OPTIONAL',
      includeIeps: 'REQUIRED',
      validFrom,
      validTo,
    });

    expect(sk.includeIva).toBe('OPTIONAL');
    expect(sk.includeIeps).toBe('REQUIRED');
    expect(sk.validFrom).toEqual(validFrom);
    expect(sk.validTo).toEqual(validTo);
  });
});

describe('SatKey — fromPersistence (B.1.3)', () => {
  it('rebuilds the entity WITHOUT re-normalizing searchText', () => {
    // Whatever the caller passes for searchText is taken at face value —
    // fromPersistence is for DB rows whose normalized text is already stored.
    const sk = SatKey.fromPersistence({
      ...BASE,
      searchText: 'PRESET-NO-NORMALIZE',
      validFrom: null,
      validTo: null,
    });

    expect(sk.searchText).toBe('PRESET-NO-NORMALIZE');
    expect(sk.key).toBe(BASE.key);
    expect(sk.description).toBe(BASE.description);
  });

  it('preserves ñ and ñ-distinctness in fromPersistence', () => {
    const a = SatKey.fromPersistence({
      ...BASE,
      key: '01010120',
      description: 'Piña',
      searchText: '01010120 piña',
    });
    const b = SatKey.fromPersistence({
      ...BASE,
      key: '01010121',
      description: 'Pina',
      searchText: '01010121 pina',
    });

    expect(a.searchText).toContain('piña');
    expect(a.searchText).not.toContain('pina');
    expect(b.searchText).toContain('pina');
    expect(b.searchText).not.toContain('piña');
  });
});

describe('SatKey.isActive (B.1.4 / B.1.5)', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  it('returns true when validTo is null (open-ended)', () => {
    const sk = SatKey.create({ ...BASE, validTo: null });
    expect(sk.isActive(now)).toBe(true);
  });

  it('returns false when validTo is strictly before now (retired)', () => {
    const sk = SatKey.create({
      ...BASE,
      validTo: new Date('2020-12-31T00:00:00.000Z'),
    });
    expect(sk.isActive(now)).toBe(false);
  });

  it('returns true when validTo is strictly after now (still in force)', () => {
    const sk = SatKey.create({
      ...BASE,
      validTo: new Date('2030-12-31T00:00:00.000Z'),
    });
    expect(sk.isActive(now)).toBe(true);
  });

  it('is callable with no argument and defaults to current time', () => {
    const sk = SatKey.create({ ...BASE, validTo: null });
    expect(typeof sk.isActive()).toBe('boolean');
    expect(sk.isActive()).toBe(true);
  });

  it('treats a past-tense key created via fromPersistence the same way', () => {
    const sk = SatKey.fromPersistence({
      ...BASE,
      searchText: '01010101 aspirina',
      validFrom: new Date('2018-01-01T00:00:00.000Z'),
      validTo: new Date('2020-12-31T00:00:00.000Z'),
    });
    expect(sk.isActive(now)).toBe(false);
  });
});
