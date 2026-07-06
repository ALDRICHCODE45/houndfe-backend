/**
 * ENTITY: SatKey (SAT c_ClaveProdServ catalog row)
 *
 * Pure domain entity. No framework dependencies.
 *
 * Mirrors the `Product` pattern: `static create(props)` is the writer-side
 * factory (runs `normalize()` so the stored `searchText` and the runtime
 * query stay byte-identical); `static fromPersistence(data)` is the
 * reader-side factory (skips normalization — DB already holds the canonical
 * stored form).
 *
 * Fields mirror `prisma/schema.prisma::SatProductServiceKey` and Slice A's
 * ingest output. `isActive(now)` codifies the ACTIVE policy
 * (`validTo === null || validTo > now`) used by the repository's search
 * query.
 */
import { normalize } from '../ingest/normalize';

export type SatInclusion = 'REQUIRED' | 'NONE' | 'OPTIONAL';

export interface SatKeyProps {
  key: string;
  description: string;
  searchText: string;
  includeIva: SatInclusion;
  includeIeps: SatInclusion;
  validFrom: Date | null;
  validTo: Date | null;
}

export class SatKey {
  public readonly key: string;
  public readonly description: string;
  public readonly searchText: string;
  public readonly includeIva: SatInclusion;
  public readonly includeIeps: SatInclusion;
  public readonly validFrom: Date | null;
  public readonly validTo: Date | null;

  private constructor(props: SatKeyProps) {
    this.key = props.key;
    this.description = props.description;
    this.searchText = props.searchText;
    this.includeIva = props.includeIva;
    this.includeIeps = props.includeIeps;
    this.validFrom = props.validFrom;
    this.validTo = props.validTo;
  }

  /** Writer-side factory: builds `searchText` from the SAME `normalize()` used at ingest. */
  static create(params: {
    key: string;
    description: string;
    includeIva?: SatInclusion;
    includeIeps?: SatInclusion;
    validFrom?: Date | null;
    validTo?: Date | null;
  }): SatKey {
    return new SatKey({
      key: params.key,
      description: params.description,
      searchText: normalize(`${params.key} ${params.description}`),
      includeIva: params.includeIva ?? 'NONE',
      includeIeps: params.includeIeps ?? 'NONE',
      validFrom: params.validFrom ?? null,
      validTo: params.validTo ?? null,
    });
  }

  /** Reader-side factory: trust the persisted `searchText` — don't re-normalize. */
  static fromPersistence(data: {
    key: string;
    description: string;
    searchText: string;
    includeIva: SatInclusion;
    includeIeps: SatInclusion;
    validFrom: Date | null;
    validTo: Date | null;
  }): SatKey {
    return new SatKey({
      key: data.key,
      description: data.description,
      searchText: data.searchText,
      includeIva: data.includeIva,
      includeIeps: data.includeIeps,
      validFrom: data.validFrom,
      validTo: data.validTo,
    });
  }

  /**
   * ACTIVE policy: `validTo === null` (open-ended) OR `validTo > now`.
   * Matches the repository's `activeClause` so the two sides agree.
   */
  isActive(now: Date = new Date()): boolean {
    if (this.validTo === null) return true;
    return this.validTo.getTime() > now.getTime();
  }
}
