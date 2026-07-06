/**
 * APPLICATION SERVICE: SatCatalogService
 *
 * Application layer for the sat-catalog context. Sits between the HTTP
 * controller (Slice C) / `ProductsService` (Slice D) and the repository
 * port. Holds no business logic beyond short-circuiting empty queries and
 * shaping the response envelope.
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { SatKey } from './domain/sat-key.entity';
import {
  ISatKeyRepository,
  SAT_KEY_REPOSITORY,
  SatKeySearchOptions,
} from './domain/sat-key.repository';

export interface SatKeySearchResult {
  items: SatKey[];
  limit: number;
  offset: number;
  total: number;
}

@Injectable()
export class SatCatalogService {
  constructor(
    @Inject(SAT_KEY_REPOSITORY)
    private readonly repo: ISatKeyRepository,
  ) {}

  /**
   * Typeahead search. Empty / whitespace-only `q` short-circuits to an empty
   * result without hitting the DB — avoids accidental full-table scans.
   */
  async search(
    q: string,
    opts: SatKeySearchOptions,
  ): Promise<SatKeySearchResult> {
    if (!q || q.trim() === '') {
      return { items: [], limit: opts.limit, offset: opts.offset, total: 0 };
    }
    const { items, total } = await this.repo.search(q, opts);
    return { items, limit: opts.limit, offset: opts.offset, total };
  }

  /** Single-key lookup. Returns active AND retired rows. */
  findByKey(key: string): Promise<SatKey | null> {
    return this.repo.findByKey(key);
  }

  /**
   * Throws `BadRequestException({ error: 'SAT_KEY_NOT_FOUND', message })`
   * when the key is unknown. Passes silently otherwise — INCLUDING on a
   * retired hit, so the product create/update path never blocks legacy keys
   * (the edit-only-on-change guard in Slice D further restricts this).
   */
  async assertExists(key: string): Promise<void> {
    const ok = await this.repo.exists(key);
    if (!ok) {
      throw new BadRequestException({
        error: 'SAT_KEY_NOT_FOUND',
        message: `SAT key "${key}" is not in the catalog. Use GET /sat-keys?search=... to find a valid key.`,
      });
    }
  }
}
