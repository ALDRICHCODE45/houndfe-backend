import type { Prisma } from '@prisma/client';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { PrismaChatbotFeedStore } from './prisma-chatbot-feed.store';

/**
 * The feed read must always be answered by `(tenantId, cursor)`. The primary
 * key is `cursor` alone, so any statement that lets the planner satisfy
 * `ORDER BY cursor` from it (a plain `tenantId = $1` plus `cursor > $2`) can
 * walk every other tenant's rows (measured: 78 ms and 21 852 buffers for an
 * idle tenant, and the same for a mid-share tenant after a gap). The shape
 * below gives it no such path: no equality on the tenant (so the tenant column
 * is not a constant of the ordering) and the range written as row comparisons.
 * The plan itself is proven by the load test's EXPLAIN.
 */
describe('PrismaChatbotFeedStore.readAfter query shape', () => {
  function capture() {
    const queries: Prisma.Sql[] = [];
    const tenantPrisma = {
      getTenantId: () => 'tenant-1',
      getClient: () => ({
        $queryRaw: (query: Prisma.Sql) => {
          queries.push(query);
          return Promise.resolve([]);
        },
      }),
    } as unknown as TenantPrismaService;
    const store = new PrismaChatbotFeedStore(tenantPrisma, {} as never);
    return { store, queries };
  }

  it('is a closed row-comparison range ordered by (tenantId, cursor)', async () => {
    const { store, queries } = capture();
    await store.readAfter(42n, 50);
    const [query] = queries;
    const text = query.sql.replace(/\s+/g, ' ');
    expect(text).toContain('("tenantId", "cursor") > (');
    expect(text).toContain('("tenantId", "cursor") <= (');
    expect(text).toContain('ORDER BY "tenantId", "cursor" LIMIT');
    // Nothing the primary key could serve on its own.
    expect(text).not.toMatch(/"tenantId" = /);
    expect(text).not.toMatch(/(?<!\()"cursor" (>|<=) /);
    expect(query.values).toEqual([
      'tenant-1',
      42n,
      'tenant-1',
      9223372036854775807n,
      50,
    ]);
  });
});
