/**
 * PORT: ISatKeyRepository (Driven Port)
 *
 * Contract that the sat-catalog domain DEMANDS for persistence.
 * Lives in domain, implemented in infrastructure. Mirrors the
 * `IProductRepository` pattern.
 *
 * ACTIVE-only vs all-rows semantics:
 *   - `search` filters ACTIVE rows (validTo IS NULL OR validTo > now).
 *   - `findByKey` and `exists` return ANY row (active OR retired) so editor
 *     UIs can resolve legacy keys and editor-load errors stay informative.
 */
import { SatKey } from './sat-key.entity';

export interface SatKeySearchOptions {
  limit: number;
  offset: number;
}

export interface ISatKeyRepository {
  /** Typeahead search. ACTIVE-only. Returns matched items + total count. */
  search(
    q: string,
    opts: SatKeySearchOptions,
  ): Promise<{ items: SatKey[]; total: number }>;

  /** Lookup by natural key. Returns active AND retired rows. */
  findByKey(key: string): Promise<SatKey | null>;

  /** Truthy if ANY row (active or retired) exists for the key. */
  exists(key: string): Promise<boolean>;
}

/** NestJS injection token — resolves `ISatKeyRepository` via the bound adapter. */
export const SAT_KEY_REPOSITORY = Symbol('SAT_KEY_REPOSITORY');
