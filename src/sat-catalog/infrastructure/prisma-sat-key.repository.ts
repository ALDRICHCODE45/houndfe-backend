/**
 * ADAPTER: PrismaSatKeyRepository
 *
 * Concrete implementation of `ISatKeyRepository` over the BASE
 * `PrismaService` (non-tenant). The `SatProductServiceKey` table is
 * national reference data and is NOT in `TENANT_SCOPED_MODELS`, so the
 * base client reaches it directly — no `TenantPrismaService` indirection.
 *
 * Query-time `normalize()` is the SAME function ingest uses
 * (`src/sat-catalog/ingest/normalize.ts`) so the stored `searchText` and
 * the runtime ILIKE compare byte-for-byte. Keeping the import here keeps
 * ingest and query from drifting.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { SatKey, type SatInclusion } from '../domain/sat-key.entity';
import type {
  ISatKeyRepository,
  SatKeySearchOptions,
} from '../domain/sat-key.repository';
import { normalize } from '../ingest/normalize';

/** Injection token for the "now" clock override (deterministic tests / clock skew). */
export const SAT_KEY_NOW = Symbol('SAT_KEY_NOW');

type SatKeyRow = {
  key: string;
  description: string;
  searchText: string;
  includeIva: SatInclusion;
  includeIeps: SatInclusion;
  validFrom: Date | null;
  validTo: Date | null;
};

type SatKeyDelegate = {
  findMany: (args: unknown) => Promise<SatKeyRow[]>;
  count: (args: unknown) => Promise<number>;
  findUnique: (args: unknown) => Promise<SatKeyRow | null>;
};

@Injectable()
export class PrismaSatKeyRepository implements ISatKeyRepository {
  /**
   * @param prisma  Base `PrismaService` (exposes `.satProductServiceKey`).
   *                Injected by class token so the Nest DI container can build
   *                this adapter at runtime — NOT a bare type literal (which
   *                erases to `Object` and breaks resolution). Tests still pass
   *                a structural mock via `new PrismaSatKeyRepository(mock, ...)`.
   * @param now     Override for the "now" used by `activeClause`. Defaults to
   *                `new Date()`. Optional so DI does not try to resolve it;
   *                deterministic tests pass a fixed clock directly.
   */
  constructor(
    @Inject(PrismaService)
    private readonly prisma: { satProductServiceKey: SatKeyDelegate },
    @Optional()
    @Inject(SAT_KEY_NOW)
    private readonly now: () => Date = () => new Date(),
  ) {}

  async search(
    q: string,
    opts: SatKeySearchOptions,
  ): Promise<{ items: SatKey[]; total: number }> {
    const n = normalize(q);
    const where = {
      AND: [
        this.activeClause(),
        {
          OR: [{ key: { startsWith: n } }, { searchText: { contains: n } }],
        },
      ],
    };

    const [rows, total] = await Promise.all([
      this.prisma.satProductServiceKey.findMany({
        where,
        take: opts.limit,
        skip: opts.offset,
        orderBy: [{ key: 'asc' }],
      }),
      this.prisma.satProductServiceKey.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toDomain(r)),
      total,
    };
  }

  async findByKey(key: string): Promise<SatKey | null> {
    const row = await this.prisma.satProductServiceKey.findUnique({
      where: { key },
    });
    return row ? this.toDomain(row) : null;
  }

  async exists(key: string): Promise<boolean> {
    const row = await this.prisma.satProductServiceKey.findUnique({
      where: { key },
    });
    return row !== null;
  }

  private activeClause() {
    const now = this.now();
    return {
      OR: [{ validTo: null }, { validTo: { gt: now } }],
    };
  }

  private toDomain(row: SatKeyRow): SatKey {
    return SatKey.fromPersistence({
      key: row.key,
      description: row.description,
      searchText: row.searchText,
      includeIva: row.includeIva,
      includeIeps: row.includeIeps,
      validFrom: row.validFrom,
      validTo: row.validTo,
    });
  }
}
