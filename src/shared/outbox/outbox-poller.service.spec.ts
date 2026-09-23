import { OutboxEventStatus } from '@prisma/client';
import { OutboxPollerService } from './outbox-poller.service';

describe('OutboxPollerService', () => {
  it('claims pending rows using FOR UPDATE SKIP LOCKED and dispatches claimed events', async () => {
    const prisma = {
      $transaction: jest.fn(),
      $queryRawUnsafe: jest.fn(),
    };
    const dispatcher = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };

    const claimed = [
      {
        id: 'evt-1',
        tenantId: 'tenant-1',
        aggregateType: 'Sale',
        aggregateId: 'sale-1',
        eventType: 'sale.confirmed',
        payload: { saleId: 'sale-1' },
        status: OutboxEventStatus.PENDING,
        retryCount: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        lockToken: 'lock-1',
        lockedUntil: new Date(),
        createdAt: new Date(),
        publishedAt: null,
      },
    ];

    // Pre-existing lint remediation (pca-3c3b): the untyped `jest.fn()`
    // made every `mock.calls[i][j]` an `any` member access. The typed
    // signature keeps the assertions below byte-identical while restoring
    // `string` for the recorded SQL argument. No behavior change.
    const txQueryRawUnsafe = jest
      .fn<Promise<unknown>, [string, ...unknown[]]>()
      .mockResolvedValueOnce([{ id: 'evt-1' }])
      .mockResolvedValueOnce(claimed);

    prisma.$transaction.mockImplementation(
      async (work: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $queryRawUnsafe: txQueryRawUnsafe,
        };
        return work(tx);
      },
    );

    const service = new OutboxPollerService(
      prisma as never,
      dispatcher as never,
      1000,
      50,
      30000,
    );

    await service.poll();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txQueryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE SKIP LOCKED'),
      expect.anything(),
    );
    expect(txQueryRawUnsafe.mock.calls[0][0]).toContain(
      '"nextAttemptAt" <= NOW()',
    );
    expect(txQueryRawUnsafe.mock.calls[0][0]).toContain(
      '"lockedUntil" IS NULL OR "lockedUntil" < NOW()',
    );
    expect(txQueryRawUnsafe.mock.calls[0][0]).toContain(
      'ORDER BY "createdAt" ASC',
    );
    expect(txQueryRawUnsafe.mock.calls[1][0]).toContain('SET "lockToken" = $1');
    expect(txQueryRawUnsafe.mock.calls[1][0]).toContain(
      '"lockedUntil" = NOW() + ($2 * INTERVAL',
    );
    expect(txQueryRawUnsafe.mock.calls[1][0]).toContain(
      '"tenantId" as "tenantId"',
    );

    expect(dispatcher.dispatch).toHaveBeenCalledWith(claimed[0]);
  });

  // ─── Slice F.3 — every dedicated eventType is excluded from the
  // generic claim predicate (finding #10 + Risk R-E). The generic
  // dispatcher CANNOT deliver a dedicated alert event durably; the
  // dedicated pollers claim those rows instead. This exclusion is the
  // predicate that makes the dispatch paths DISJOINT. pca-3b3b adds
  // `promotion.near_capacity.detected` when the dedicated
  // capacity poller/module is wired into the application, and pca-3c3b
  // adds `promotion.expiring.detected` so the expiry poller owns those
  // rows exclusively while its module stays inert until pca-3c4c.
  describe('Slice F.3 + Slice 4 + pca-3b3b + pca-3c3b — generic claim excludes every dedicated eventType', () => {
    it('claim SELECT contains a NOT IN predicate covering the three alert types, promotion.near_capacity.detected AND promotion.expiring.detected', async () => {
      const capturedCalls: string[] = [];
      const prisma = {
        $transaction: (work: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            $queryRawUnsafe: jest.fn().mockImplementation((sql: string) => {
              capturedCalls.push(sql);
              return Promise.resolve([]);
            }),
          };
          return work(tx);
        },
        $queryRawUnsafe: jest.fn(),
      };
      const dispatcher = { dispatch: jest.fn() };

      const service = new OutboxPollerService(
        prisma as never,
        dispatcher as never,
        1000,
        50,
        30000,
      );

      await service.poll();

      // The first $queryRawUnsafe call within the tx callback is the
      // claim SELECT (FOR UPDATE SKIP LOCKED). It's the only call that
      // touches the WHERE clause predicates we care about.
      const claimSql =
        capturedCalls.find((c) =>
          /SELECT\s+id\s+FROM\s+outbox_events/i.test(c),
        ) ?? '';
      // Slice 4 + WU3 (delivery-routes) + pca-3b3b (promotion-capacity) +
      // pca-3c3b (promotion-expiry): the exclusion covers ALL five
      // dedicated event types — low-stock (`stock.low.detected`),
      // hr-time-off (`hr.timeoff.requested`), delivery-routes
      // (`delivery.next_stop.notify`), the promotion capacity crossing
      // (`promotion.near_capacity.detected`), and the promotion expiry
      // alert (`promotion.expiring.detected`). The generic poller must
      // skip every dedicated-type row so the dedicated pollers own them
      // exclusively; while the expiry module stays unregistered
      // (pca-3c4c), excluded expiry rows simply remain PENDING instead of
      // being fire-and-forget published.
      expect(claimSql).toContain(
        `"eventType" NOT IN ('stock.low.detected', 'hr.timeoff.requested', 'delivery.next_stop.notify', 'promotion.near_capacity.detected', 'promotion.expiring.detected')`,
      );
      // TRIANGULATE — the exclusion is additive, not a replacement: the
      // three pre-existing alert types and the capacity crossing stay
      // excluded alongside the new expiry type.
      expect(claimSql).toContain(`'stock.low.detected'`);
      expect(claimSql).toContain(`'hr.timeoff.requested'`);
      expect(claimSql).toContain(`'delivery.next_stop.notify'`);
      expect(claimSql).toContain(`'promotion.near_capacity.detected'`);
      expect(claimSql).toContain(`'promotion.expiring.detected'`);
    });

    it('non-alert PENDING rows still get claimed by the generic poller (exclusion is scoped, not broad)', async () => {
      const dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
      const claimedSaleEvent = {
        id: 'evt-sale',
        tenantId: 'tenant-1',
        aggregateType: 'Sale',
        aggregateId: 'sale-1',
        eventType: 'sale.confirmed',
        payload: { saleId: 'sale-1' },
        status: OutboxEventStatus.PENDING,
        retryCount: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        lockToken: 'lock-1',
        lockedUntil: new Date(),
        createdAt: new Date(),
        publishedAt: null,
      };

      const service = new OutboxPollerService(
        {
          $transaction: (work: (tx: unknown) => Promise<unknown>) =>
            work({
              $queryRawUnsafe: jest
                .fn()
                .mockResolvedValueOnce([{ id: 'evt-sale' }])
                .mockResolvedValueOnce([claimedSaleEvent]),
            }),
          $queryRawUnsafe: jest.fn(),
        } as never,
        dispatcher as never,
        1000,
        50,
        30000,
      );

      await service.poll();

      // Generic dispatcher dispatched the non-alert event — the
      // generic dispatcher's fire-and-forget semantics are UNCHANGED
      // for non-alert event types (design.md Risk R-E).
      expect(dispatcher.dispatch).toHaveBeenCalledWith(claimedSaleEvent);
    });
  });
});
