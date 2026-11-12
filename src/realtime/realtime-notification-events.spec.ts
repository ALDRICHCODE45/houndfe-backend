/**
 * The notification producer of the realtime log (unit 8): the batch form writes
 * ONE lock, one insert per recipient and ONE `NOTIFY` for the whole batch
 * (the per-recipient form repeated lock + NOTIFY for every person).
 */
import type { Prisma } from '@prisma/client';
import { RealtimeNotificationEvents } from '../notifications/infrastructure/realtime-notification-events';

const created = (userId: string, n: number) => ({
  tenantId: 't1',
  userId,
  notificationId: `n${n}`,
  type: 'REQUEST_CREATED',
  requestId: 'r1',
});

function fakeTx() {
  const statements: string[] = [];
  const tx = {
    $queryRaw: (query: Prisma.Sql) => {
      statements.push(query.strings.join('?').replace(/\s+/g, ' ').trim());
      return Promise.resolve([]);
    },
  } as unknown as Prisma.TransactionClient;
  const kinds = () =>
    statements.map((s) =>
      s.includes('pg_advisory_xact_lock')
        ? 'lock'
        : s.includes('INSERT')
          ? 'insert'
          : s.includes('pg_notify')
            ? 'notify'
            : 'other',
    );
  return { tx, kinds };
}

describe('RealtimeNotificationEvents', () => {
  it('publishCreatedMany: one lock, one insert per recipient, one notify', async () => {
    const { tx, kinds } = fakeTx();
    await new RealtimeNotificationEvents().publishCreatedMany(tx, [
      created('ana', 1),
      created('luis', 2),
      created('eva', 3),
    ]);
    expect(kinds()).toEqual(['lock', 'insert', 'insert', 'insert', 'notify']);
  });

  it('publishCreatedMany with nobody writes nothing', async () => {
    const { tx, kinds } = fakeTx();
    await new RealtimeNotificationEvents().publishCreatedMany(tx, []);
    expect(kinds()).toEqual([]);
  });

  it('publishCreated (one person) is still lock, insert, notify', async () => {
    const { tx, kinds } = fakeTx();
    await new RealtimeNotificationEvents().publishCreated(
      tx,
      created('ana', 1),
    );
    expect(kinds()).toEqual(['lock', 'insert', 'notify']);
  });
});
