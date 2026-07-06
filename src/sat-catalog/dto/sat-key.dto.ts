/**
 * Slice C — response shape DTO for a SAT catalog row.
 *
 * Mirrors `prisma/schema.prisma::SatProductServiceKey` (non-tenant,
 * national reference data). Excludes `searchText` (internal cache of
 * normalize(key+' '+description)) and only exposes the 6 queryable
 * columns the editor UI needs:
 *   - key, description (identity + display)
 *   - includeIva, includeIeps (translado flags; drive UI helpers)
 *   - validFrom, validTo (window — `null` validTo = open-ended active)
 */
import type { SatInclusion } from '../domain/sat-key.entity';

export class SatKeyDto {
  key!: string;
  description!: string;
  includeIva!: SatInclusion;
  includeIeps!: SatInclusion;
  validFrom!: Date | null;
  validTo!: Date | null;
}
