import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { ReceiptReviewOutboxDispatcher } from './receipt-review-outbox.dispatcher';
import { ReceiptReviewOutboxPoller } from './receipt-review-outbox.poller';

function harness(claimedRows: Array<{ id: string }>) {
  const sql: string[] = [];
  const tx = {
    $queryRawUnsafe: jest.fn((query: string) => {
      sql.push(query);
      if (/^\s*SELECT/i.test(query)) {
        return Promise.resolve(claimedRows.map(({ id }) => ({ id })));
      }
      return Promise.resolve(claimedRows);
    }),
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  } as unknown as PrismaService;
  const dispatch = jest.fn().mockResolvedValue(undefined);
  const poller = new ReceiptReviewOutboxPoller(prisma, 0, 25, 60000, {
    dispatch,
  } as unknown as ReceiptReviewOutboxDispatcher);
  return { poller, sql, dispatch };
}

describe('ReceiptReviewOutboxPoller', () => {
  it('claims only receipt.review_requested rows with SKIP LOCKED', async () => {
    const { poller, sql } = harness([]);

    await poller.claimBatch();

    expect(sql[0]).toContain(`"eventType" = 'receipt.review_requested'`);
    expect(sql[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql[0]).not.toContain('NOT IN');
  });

  it('dispatches every claimed row and survives a throwing one', async () => {
    const { poller, dispatch } = harness([{ id: 'a' }, { id: 'b' }]);
    dispatch.mockRejectedValueOnce(new Error('boom'));

    await expect(poller.poll()).resolves.toBeUndefined();

    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
