/**
 * Slice A — SAT catalog seed ingest.
 *
 * Thin wrapper around the pure parse helpers in `src/sat-catalog/ingest/`.
 * Reads the real file if present, otherwise the fixture; pushes rows into
 * `SatProductServiceKey` via batched `createMany({ skipDuplicates: true })`.
 *
 * Idempotency: `key` is the PK and `skipDuplicates: true` makes re-runs a
 * no-op on existing rows — `COUNT(*)` stays stable, no NULL/empty key.
 *
 * Pure parse logic lives in `src/sat-catalog/ingest/` so it can be unit
 * tested without a DB AND so Slice B's repository can reuse the SAME
 * `normalize()` at query time (avoids ingest/query drift).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSatRows,
  type ParsedSatRow,
} from '../src/sat-catalog/ingest/parse-sat-rows';

const BATCH_SIZE = 1000;

const REAL_CSV_PATH = join(__dirname, 'data', 'sat-clave-prod-serv.csv');
const FIXTURE_CSV_PATH = join(__dirname, 'data', 'sat-clave-prod-serv.fixture.csv');

export interface SatIngestPrisma {
  satProductServiceKey: {
    createMany(args: {
      data: Array<{
        key: string;
        description: string;
        searchText: string;
        includeIva: 'REQUIRED' | 'NONE' | 'OPTIONAL';
        includeIeps: 'REQUIRED' | 'NONE' | 'OPTIONAL';
        validFrom: Date | null;
        validTo: Date | null;
      }>;
      skipDuplicates?: boolean;
    }): Promise<{ count: number }>;
  };
}

/**
 * Ingest the SAT c_ClaveProdServ catalog into `SatProductServiceKey`.
 *
 * Resolves the source file in this order:
 *   1. `prisma/data/sat-clave-prod-serv.csv` (real ~52k file, user-supplied)
 *   2. `prisma/data/sat-clave-prod-serv.fixture.csv` (10-row fixture)
 *
 * Returns the total number of rows written across all batches.
 */
export async function ingestSatCatalog(
  prisma: SatIngestPrisma,
  filePath: string = (() =>
    safeExists(REAL_CSV_PATH) ? REAL_CSV_PATH : FIXTURE_CSV_PATH)(),
): Promise<{ totalWritten: number; batches: number; source: string }> {
  const csv = readFileSync(filePath, 'utf8');
  const rows = parseSatRows(csv);

  let totalWritten = 0;
  let batches = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const result = await prisma.satProductServiceKey.createMany({
      data: batch.map((r: ParsedSatRow) => ({
        key: r.key,
        description: r.description,
        searchText: r.searchText,
        includeIva: r.includeIva,
        includeIeps: r.includeIeps,
        validFrom: r.validFrom,
        validTo: r.validTo,
      })),
      skipDuplicates: true,
    });
    totalWritten += result.count;
    batches++;
  }

  return { totalWritten, batches, source: filePath };
}

function safeExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}