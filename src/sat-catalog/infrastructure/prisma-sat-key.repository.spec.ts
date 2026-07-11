/**
 * Slice B — PrismaSatKeyRepository adapter tests.
 *
 * Covers spec scenarios in tasks B.2.2, B.2.3, B.2.4:
 *   - `search` runs the SAME `normalize()` as ingest/seed before issuing
 *     the ILIKE — accent-insensitive but `ñ` PRESERVED (`medicacion`
 *     matches `Medicación`; `piña` does NOT collide with `pina`).
 *   - `search` applies the ACTIVE filter (`validTo IS NULL OR validTo > now`).
 *   - `search` honors `take` (limit cap) and `skip` (offset).
 *   - `search` returns `{ items, total }` (count is independent of limit).
 *   - `findByKey` returns retired rows; `exists` is true for retired keys.
 *
 * Mirrors the `prisma-product.repository.spec.ts` pattern: mocks the base
 * `PrismaService` surface only. No live DB required.
 */
import { PrismaSatKeyRepository } from './prisma-sat-key.repository';

const NOW = new Date('2026-07-01T00:00:00.000Z');

function row(
  overrides: Partial<{
    key: string;
    description: string;
    searchText: string;
    includeIva: 'REQUIRED' | 'NONE' | 'OPTIONAL';
    includeIeps: 'REQUIRED' | 'NONE' | 'OPTIONAL';
    validFrom: Date | null;
    validTo: Date | null;
  }>,
) {
  return {
    key: '01010101',
    description: 'Aspirina',
    searchText: '01010101 aspirina',
    includeIva: 'REQUIRED' as const,
    includeIeps: 'NONE' as const,
    validFrom: null,
    validTo: null,
    ...overrides,
  };
}

function makePrismaMock() {
  const findMany = jest.fn();
  const count = jest.fn();
  const findUnique = jest.fn();
  return {
    prisma: {
      satProductServiceKey: { findMany, count, findUnique },
    },
    findMany,
    count,
    findUnique,
  };
}

function makeRepo(prismaLike: unknown) {
  return new PrismaSatKeyRepository(prismaLike as never, () => NOW);
}

describe('PrismaSatKeyRepository.search (B.2.2 / B.2.3 / B.2.4)', () => {
  it('runs normalize(q) before building the where clause', async () => {
    const { prisma, findMany, count } = makePrismaMock();
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    const repo = makeRepo(prisma);
    await repo.search('Medicación  ', { limit: 10, offset: 0 });

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    const where = args.where as {
      AND: Array<Record<string, unknown>>;
    };
    // Outer AND: [ activeClause, OR-clause ]
    expect(Array.isArray(where.AND)).toBe(true);
    expect(where.AND).toHaveLength(2);

    // Inner OR: startsWith(key) on raw key + contains on normalized searchText.
    // The query string passed is "Medicación  " → normalized to "medicacion";
    // raw key is matched with the SAME normalized string via startsWith.
    const orClause = where.AND[1] as { OR: Array<Record<string, unknown>> };
    expect(Array.isArray(orClause.OR)).toBe(true);
    expect(orClause.OR).toHaveLength(2);
    expect(orClause.OR[0]).toEqual({ key: { startsWith: 'medicacion' } });
    expect(orClause.OR[1]).toEqual({
      searchText: { contains: 'medicacion' },
    });
  });

  it('applies ACTIVE-only filter: validTo null OR validTo > now', async () => {
    const { prisma, findMany, count } = makePrismaMock();
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    const repo = makeRepo(prisma);
    await repo.search('aspirina', { limit: 10, offset: 0 });

    const args = findMany.mock.calls[0][0] as {
      where: { AND: Array<Record<string, unknown>> };
    };
    const activeClause = args.where.AND[0] as {
      OR: Array<Record<string, unknown>>;
    };

    expect(activeClause.OR).toEqual([
      { validTo: null },
      { validTo: { gt: NOW } },
    ]);
  });

  it('honors limit (take) and offset (skip), orderBy key asc', async () => {
    const { prisma, findMany, count } = makePrismaMock();
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    const repo = makeRepo(prisma);
    await repo.search('a', { limit: 20, offset: 30 });

    const args = findMany.mock.calls[0][0];
    expect(args.take).toBe(20);
    expect(args.skip).toBe(30);
    expect(args.orderBy).toEqual([{ key: 'asc' }]);
  });

  it('returns { items, total } — total comes from count(where) not findMany length', async () => {
    const { prisma, findMany, count } = makePrismaMock();
    findMany.mockResolvedValue([
      row({ key: '01010101', description: 'Aspirina' }),
      row({ key: '01010102', description: 'Aspirina plus' }),
    ]);
    // total is independent of take/skip — proves we run a real count.
    count.mockResolvedValue(57);

    const repo = makeRepo(prisma);
    const result = await repo.search('aspirina', { limit: 2, offset: 0 });

    expect(result.total).toBe(57);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].key).toBe('01010101');
    expect(result.items[0].searchText).toBe('01010101 aspirina');
    expect(count).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith({
      where: findMany.mock.calls[0][0].where,
    });
  });

  it('accent-insensitive match: query "MEDICACIÓN" matches a row with description "Medicación"', async () => {
    const { prisma, findMany, count } = makePrismaMock();
    findMany.mockResolvedValue([
      row({
        key: '01010103',
        description: 'Medicación',
        searchText: '01010103 medicacion',
      }),
    ]);
    count.mockResolvedValue(1);

    const repo = makeRepo(prisma);
    const r1 = await repo.search('medicacion', { limit: 10, offset: 0 });
    const r2 = await repo.search('MEDICACIÓN', { limit: 10, offset: 0 });

    expect(r1.items).toHaveLength(1);
    expect(r2.items).toHaveLength(1);
    // Both normalized to "medicacion" → same contains/startsWith payload.
    const a = findMany.mock.calls[0][0];
    const b = findMany.mock.calls[1][0];
    expect((a.where.AND[1] as { OR: unknown[] }).OR[1]).toEqual({
      searchText: { contains: 'medicacion' },
    });
    expect((b.where.AND[1] as { OR: unknown[] }).OR[1]).toEqual({
      searchText: { contains: 'medicacion' },
    });
  });

  it('does NOT collapse ñ: "piña" and "pina" produce different normalized queries', async () => {
    const { prisma, findMany, count } = makePrismaMock();
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    const repo = makeRepo(prisma);
    await repo.search('piña', { limit: 10, offset: 0 });
    await repo.search('pina', { limit: 10, offset: 0 });

    const a = findMany.mock.calls[0][0];
    const b = findMany.mock.calls[1][0];
    expect((a.where.AND[1] as { OR: unknown[] }).OR[1]).toEqual({
      searchText: { contains: 'piña' },
    });
    expect((b.where.AND[1] as { OR: unknown[] }).OR[1]).toEqual({
      searchText: { contains: 'pina' },
    });
    expect(a).not.toEqual(b);
  });

  it('trims the query before normalizing', async () => {
    const { prisma, findMany, count } = makePrismaMock();
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);

    const repo = makeRepo(prisma);
    await repo.search('   Aspirina   ', { limit: 10, offset: 0 });

    const args = findMany.mock.calls[0][0];
    expect((args.where.AND[1] as { OR: unknown[] }).OR[1]).toEqual({
      searchText: { contains: 'aspirina' },
    });
  });
});

describe('PrismaSatKeyRepository.findByKey (B.2.4)', () => {
  it('returns the row WITHOUT applying the activeClause', async () => {
    const { prisma, findUnique } = makePrismaMock();
    findUnique.mockResolvedValue(
      row({
        key: '99999999',
        description: 'Retired key',
        searchText: '99999999 retired key',
        validFrom: new Date('2018-01-01T00:00:00.000Z'),
        validTo: new Date('2020-12-31T00:00:00.000Z'), // retired
      }),
    );

    const repo = makeRepo(prisma);
    const result = await repo.findByKey('99999999');

    expect(findUnique).toHaveBeenCalledWith({
      where: { key: '99999999' },
    });
    expect(result).not.toBeNull();
    expect(result!.key).toBe('99999999');
    expect(result!.isActive(NOW)).toBe(false);
  });

  it('returns null when no row matches', async () => {
    const { prisma, findUnique } = makePrismaMock();
    findUnique.mockResolvedValue(null);

    const repo = makeRepo(prisma);
    const result = await repo.findByKey('00000000');

    expect(result).toBeNull();
  });
});

describe('PrismaSatKeyRepository.exists (B.2.1)', () => {
  it('returns true when findUnique returns a row (retired or active)', async () => {
    const { prisma, findUnique } = makePrismaMock();
    findUnique.mockResolvedValue(
      row({ key: '99999999', validTo: new Date('2020-12-31T00:00:00.000Z') }),
    );

    const repo = makeRepo(prisma);
    await expect(repo.exists('99999999')).resolves.toBe(true);
  });

  it('returns false when findUnique returns null', async () => {
    const { prisma, findUnique } = makePrismaMock();
    findUnique.mockResolvedValue(null);

    const repo = makeRepo(prisma);
    await expect(repo.exists('00000000')).resolves.toBe(false);
  });
});
