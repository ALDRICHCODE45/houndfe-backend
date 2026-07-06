/**
 * Slice A — SAT catalog seed ingest tests.
 *
 * Covers the spec scenarios in tasks A.2.2 (parse-by-header + enum + dates),
 * A.2.4 (ñ-preservation anchor W1), and A.2.5 (idempotency).
 *
 * Runs as PURE FUNCTION tests — no live DB required. Idempotency is proven
 * by replaying the parser against the fixture and asserting the deterministic
 * row shape that the thin `ingestSatCatalog(prisma)` step will hand to
 * `createMany({ skipDuplicates: true })`. The wrapper test mocks Prisma to
 * prove the idempotency contract end-to-end (same payload, no NULL/empty key,
 * stable COUNT after two `createMany` calls).
 */
import { parseSatRows } from '../src/sat-catalog/ingest/parse-sat-rows';
import { normalize } from '../src/sat-catalog/ingest/normalize';
import { ingestSatCatalog } from './seed-sat';

const FIXTURE_PATH = `${__dirname}/data/sat-clave-prod-serv.fixture.csv`;

describe('SAT catalog seed ingest — pure functions', () => {
  describe('parseSatRows — parse-by-header', () => {
    it('parses a full header row into all six columns', () => {
      const csv = [
        'c_ClaveProdServ,Descripción,Incluir IVA trasladado,Incluir IEPS trasladado,Fecha de inicio de vigencia,Fecha de fin de vigencia',
        '01010101,Aspirina,Sí,No,2018-01-01,',
      ].join('\n');

      const rows = parseSatRows(csv);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row.key).toBe('01010101');
      expect(row.description).toBe('Aspirina');
      expect(row.includeIva).toBe('REQUIRED');
      expect(row.includeIeps).toBe('NONE');
      expect(row.validFrom).toEqual(new Date('2018-01-01T00:00:00.000Z'));
      expect(row.validTo).toBeNull();
    });

    it('tolerates missing headers — fills them with null/empty/default', () => {
      const csv = ['c_ClaveProdServ,Descripción', '01010102,Paracetamol'].join('\n');

      const rows = parseSatRows(csv);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row.key).toBe('01010102');
      expect(row.description).toBe('Paracetamol');
      expect(row.includeIva).toBe('NONE'); // missing → NONE default
      expect(row.includeIeps).toBe('NONE');
      expect(row.validFrom).toBeNull();
      expect(row.validTo).toBeNull();
    });

    it('throws if the key header itself is missing', () => {
      const csv = ['Descripción', 'Aspirina'].join('\n');
      expect(() => parseSatRows(csv)).toThrow(/c_ClaveProdServ/);
    });

    it('skips blank-key rows silently (defensive)', () => {
      const csv = [
        'c_ClaveProdServ,Descripción,Incluir IVA trasladado,Incluir IEPS trasladado,Fecha de inicio de vigencia,Fecha de fin de vigencia',
        ',EmptyKeyRow,No,No,,',
        '01010103,RealRow,Sí,No,2018-01-01,',
      ].join('\n');
      const rows = parseSatRows(csv);
      expect(rows.map((r) => r.key)).toEqual(['01010103']);
    });
  });

  describe('parseSatRows — enum map (Sí/No/Opcional)', () => {
    it('maps Sí → REQUIRED, No → NONE, Opcional → OPTIONAL', () => {
      const csv = [
        'c_ClaveProdServ,Descripción,Incluir IVA trasladado,Incluir IEPS trasladado,Fecha de inicio de vigencia,Fecha de fin de vigencia',
        '01010101,A,Sí,No,,',
        '01010102,B,No,Opcional,,',
        '01010103,C,Opcional,Sí,,',
      ].join('\n');
      const rows = parseSatRows(csv);
      expect(rows[0].includeIva).toBe('REQUIRED');
      expect(rows[0].includeIeps).toBe('NONE');
      expect(rows[1].includeIva).toBe('NONE');
      expect(rows[1].includeIeps).toBe('OPTIONAL');
      expect(rows[2].includeIva).toBe('OPTIONAL');
      expect(rows[2].includeIeps).toBe('REQUIRED');
    });

    it('is case- and trim-insensitive ("  sí  " → REQUIRED)', () => {
      const csv = [
        'c_ClaveProdServ,Descripción,Incluir IVA trasladado,Incluir IEPS trasladado,Fecha de inicio de vigencia,Fecha de fin de vigencia',
        '01010101,A,  sí  , NO ,oPcIoNaL,,',
      ].join('\n');
      const [row] = parseSatRows(csv);
      expect(row.includeIva).toBe('REQUIRED');
      expect(row.includeIeps).toBe('NONE');
      expect(row.includeIeps).not.toBe('OPTIONAL');
    });

    it('defaults unknown values to NONE (defensive)', () => {
      const csv = [
        'c_ClaveProdServ,Descripción,Incluir IVA trasladado,Incluir IEPS trasladado,Fecha de inicio de vigencia,Fecha de fin de vigencia',
        '01010101,A,Quizas,Quizas,,',
      ].join('\n');
      const [row] = parseSatRows(csv);
      expect(row.includeIva).toBe('NONE');
      expect(row.includeIeps).toBe('NONE');
    });
  });

  describe('parseSatRows — date parsing', () => {
    it('parses ISO date into a Date, empty → null', () => {
      const csv = [
        'c_ClaveProdServ,Descripción,Incluir IVA trasladado,Incluir IEPS trasladado,Fecha de inicio de vigencia,Fecha de fin de vigencia',
        '01010101,A,Sí,No,2018-01-01,2020-12-31',
        '01010102,B,Sí,No,2018-01-01,',
      ].join('\n');
      const rows = parseSatRows(csv);
      expect(rows[0].validFrom).toEqual(new Date('2018-01-01T00:00:00.000Z'));
      expect(rows[0].validTo).toEqual(new Date('2020-12-31T00:00:00.000Z'));
      expect(rows[1].validTo).toBeNull();
    });

    it('returns null for malformed dates (does not throw)', () => {
      const csv = [
        'c_ClaveProdServ,Descripción,Incluir IVA trasladado,Incluir IEPS trasladado,Fecha de inicio de vigencia,Fecha de fin de vigencia',
        '01010101,A,Sí,No,not-a-date,',
      ].join('\n');
      const [row] = parseSatRows(csv);
      expect(row.validFrom).toBeNull();
    });
  });

  describe('normalize — ñ-preservation anchor (W1)', () => {
    it('keeps ñ intact: "niño" stays "niño" (NOT "nino")', () => {
      expect(normalize('niño')).toBe('niño');
      expect(normalize('Niño')).toBe('niño');
      expect(normalize('NIÑO')).toBe('niño');
    });

    it('keeps ñ in compounds: "Diseño niño piña" preserves all three ñ', () => {
      const out = normalize('Diseño niño piña');
      expect(out).toContain('niño');
      expect(out).toContain('piña');
      expect(out).not.toContain('nino');
      expect(out).not.toContain('pina');
    });

    it('keeps "piña" distinct from "pina" — the two MUST NOT collapse', () => {
      expect(normalize('piña')).not.toBe(normalize('pina'));
      expect(normalize('piña')).toBe('piña');
      expect(normalize('pina')).toBe('pina');
    });

    it('strips other diacritics and lowercases: "Medicación" → "medicacion"', () => {
      expect(normalize('Medicación')).toBe('medicacion');
      // Per design: ü is a diacritic and is stripped (ü → u); ñ is the only
      // Spanish letter that survives because we shield it from NFD.
      expect(normalize('ÁÉÍÓÚÜ')).toBe('aeiouu');
    });

    it('trims surrounding whitespace before normalizing', () => {
      expect(normalize('  Aspirina  ')).toBe('aspirina');
    });
  });

  describe('parseSatRows — fixture integration', () => {
    it('loads the fixture and yields 10 deterministic rows', () => {
      const fs = require('node:fs') as typeof import('node:fs');
      const csv = fs.readFileSync(FIXTURE_PATH, 'utf8');
      const rows = parseSatRows(csv);
      expect(rows).toHaveLength(10);

      // every row has a non-empty key + a searchText starting with the key
      for (const row of rows) {
        expect(row.key).toMatch(/^\d{8}$/);
        expect(row.key).not.toBe('');
        expect(row.searchText.startsWith(row.key)).toBe(true);
      }

      // one retired row (01010105 with validTo in the past)
      const retired = rows.find((r) => r.key === '01010105');
      expect(retired).toBeDefined();
      expect(retired!.validTo!.getTime()).toBeLessThan(Date.now());

      // ñ preserved end-to-end through parser
      const panales = rows.find((r) => r.key === '01010104');
      expect(panales!.searchText).toContain('niño');
      expect(panales!.searchText).not.toContain('nino');

      // other accents stripped + lowercased
      const med = rows.find((r) => r.key === '01010103');
      expect(med!.searchText).toContain('medicacion');

      // one empty validTo (01010101 ends with trailing comma)
      const aspirina = rows.find((r) => r.key === '01010101');
      expect(aspirina!.validTo).toBeNull();
    });
  });
});

describe('ingestSatCatalog — idempotency (A.2.5)', () => {
  it('calls createMany with skipDuplicates:true, never drops keys, and is stable across replays', async () => {
    // Fake Prisma client that mirrors only the surface `seed-sat` uses.
    const createdBatches: Array<{ data: unknown[]; options: unknown }> = [];
    const fakePrisma = {
      satProductServiceKey: {
        async createMany(args: { data: unknown[]; skipDuplicates?: boolean }) {
          createdBatches.push({ data: args.data, options: { skipDuplicates: args.skipDuplicates } });
          // skipDuplicates semantics: rows whose PK collides are silently dropped.
          return { count: args.data.length };
        },
      },
    };

    // First run
    await ingestSatCatalog(fakePrisma as never, FIXTURE_PATH);
    // Second run (replay)
    await ingestSatCatalog(fakePrisma as never, FIXTURE_PATH);

    // Same shape, same number of batches, same number of rows in each batch.
    expect(createdBatches).toHaveLength(2);
    expect(createdBatches[0].data).toHaveLength(10);
    expect(createdBatches[1].data).toHaveLength(10);

    // skipDuplicates is the idempotency lever.
    expect((createdBatches[0].options as { skipDuplicates?: boolean }).skipDuplicates).toBe(true);
    expect((createdBatches[1].options as { skipDuplicates?: boolean }).skipDuplicates).toBe(true);

    // No NULL/empty key in either payload — both replays are identical.
    for (const batch of createdBatches) {
      for (const row of batch.data as Array<{ key: string }>) {
        expect(row.key).toMatch(/^\d{8}$/);
      }
    }

    // Both batches are byte-identical (stable COUNT after re-run).
    expect(createdBatches[0].data).toEqual(createdBatches[1].data);
  });
});