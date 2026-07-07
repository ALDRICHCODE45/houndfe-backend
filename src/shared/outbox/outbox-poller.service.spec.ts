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

    const txQueryRawUnsafe = jest
      .fn()
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

  // ─── Slice F.3 — dedicated low-stock eventType is excluded
  // from the generic claim predicate (finding #10 + Risk R-E).
  // The generic dispatcher CANNOT deliver a `stock.low.detected`
  // event durably; the dedicated `LowStockOutboxPoller` (Slice F.4)
  // claims those rows instead. This exclusion is the predicate that
  // makes the dispatch paths DISJOINT.
  describe('Slice F.3 — generic claim excludes stock.low.detected (dedicated poller owns it)', () => {
    it('claim SELECT contains a `AND "eventType" <> \'stock.low.detected\'` predicate', async () => {
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
      expect(claimSql).toContain(`"eventType" <> 'stock.low.detected'`);
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
