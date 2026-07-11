/**
 * SAT catalog ingest — pure CSV parser (no DB, no FS).
 *
 * Parses by header name per the spec's "SAT Data File Header Contract".
 * Missing headers → null/empty (tolerated). Enum values mapped case/trim
 * insensitive. Empty `validTo` → null. `searchText` is built with the SAME
 * `normalize()` used at query time so ingest and ILIKE match byte-for-byte.
 *
 * CSV handling is intentionally minimal: this is a known-shape provider file
 * (the real SAT CSV uses standard comma separators without embedded newlines
 * inside fields). If we ever need RFC-4180-escaped quotes we'll add a tiny
 * dependency; today the fixture and the published file are plain.
 */
import { normalize } from './normalize';

export type SatInclusion = 'REQUIRED' | 'NONE' | 'OPTIONAL';

export interface ParsedSatRow {
  key: string;
  description: string;
  includeIva: SatInclusion;
  includeIeps: SatInclusion;
  validFrom: Date | null;
  validTo: Date | null;
  searchText: string;
}

export const SAT_HEADERS = [
  'c_ClaveProdServ',
  'Descripción',
  'Incluir IVA trasladado',
  'Incluir IEPS trasladado',
  'Fecha de inicio de vigencia',
  'Fecha de fin de vigencia',
] as const;

const INCLUSION_MAP: Record<string, SatInclusion> = {
  si: 'REQUIRED',
  sí: 'REQUIRED',
  no: 'NONE',
  opcional: 'OPTIONAL',
};

function mapInclusion(raw: string | undefined): SatInclusion {
  if (!raw) return 'NONE';
  const key = raw.trim().toLowerCase();
  return INCLUSION_MAP[key] ?? 'NONE';
}

function parseIsoDate(raw: string | undefined): Date | null {
  if (!raw || !raw.trim()) return null;
  // Date-only inputs become midnight UTC; the column is DateTime? in Prisma.
  const iso =
    raw.trim().length === 10 ? `${raw.trim()}T00:00:00.000Z` : raw.trim();
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Split a single CSV line honoring double-quoted fields (RFC-4180 lite).
 * Empty/undefined fields return ''.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse a SAT catalog CSV buffer into rows ready for createMany. Throws on
 * malformed data only if the header row is missing the key column entirely.
 */
export function parseSatRows(csvText: string): ParsedSatRow[] {
  const text = csvText.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const keyIdx = idx('c_ClaveProdServ');
  if (keyIdx < 0) {
    throw new Error(
      'SAT catalog CSV is missing the required "c_ClaveProdServ" header',
    );
  }
  const descIdx = idx('Descripción');
  const ivaIdx = idx('Incluir IVA trasladado');
  const iepsIdx = idx('Incluir IEPS trasladado');
  const fromIdx = idx('Fecha de inicio de vigencia');
  const toIdx = idx('Fecha de fin de vigencia');

  const rows: ParsedSatRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]);
    const key = (fields[keyIdx] ?? '').trim();
    if (!key) continue; // skip blank-key rows (idempotency guard)

    const description = descIdx >= 0 ? (fields[descIdx] ?? '').trim() : '';
    const includeIva = mapInclusion(ivaIdx >= 0 ? fields[ivaIdx] : undefined);
    const includeIeps = mapInclusion(
      iepsIdx >= 0 ? fields[iepsIdx] : undefined,
    );
    const validFrom = parseIsoDate(fromIdx >= 0 ? fields[fromIdx] : undefined);
    const validTo = parseIsoDate(toIdx >= 0 ? fields[toIdx] : undefined);

    rows.push({
      key,
      description,
      includeIva,
      includeIeps,
      validFrom,
      validTo,
      searchText: normalize(`${key} ${description}`),
    });
  }
  return rows;
}
