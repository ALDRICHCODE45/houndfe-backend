/**
 * SAT catalog ingest — accent-insensitive normalization that PRESERVES ñ/Ñ.
 *
 * ñ is a distinct Spanish letter (NOT an accented n). Naive
 *   s.normalize('NFD').replace(/\p{Diacritic}/gu, '')
 * collapses "niño" → "nino" and makes "piña" collide with "pina" — breaking
 * accent-insensitive search for the most common Spanish diminutive and fruit.
 *
 * Algorithm: shield ñ/Ñ with sentinel chars BEFORE NFD decomposition, strip
 * other combining marks, restore ñ (lowercased), then lowercase + trim. Same
 * function is used at ingest (stored `searchText`) and on query (ILIKE) so the
 * two match byte-for-byte.
 *
 * Re-exported from Slice B's repository/email for query-time ILIKE; keeping
 * the single source of truth here avoids drift between ingest and query.
 */
export function normalize(input: string): string {
  return input
    .replace(/ñ/g, '\u0001')
    .replace(/Ñ/g, '\u0002')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\u0001/g, 'ñ')
    .replace(/\u0002/g, 'ñ')
    .toLowerCase()
    .trim();
}