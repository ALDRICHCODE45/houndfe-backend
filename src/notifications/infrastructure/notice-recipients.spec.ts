import type { ChatbotRequestNotice } from '../domain/chatbot-request-notice';
import { resolveRecipients } from './notice-recipients';

/**
 * The permission query is covered against PostgreSQL in
 * `notifications.integration.spec.ts`; here the database is a fake that
 * answers with the holders and the memberships, to pin the `reason` rule.
 */
function fakeTx(opts: { holders: string[]; members: string[] }) {
  return {
    user: {
      findMany: jest.fn(() =>
        Promise.resolve(opts.holders.map((id) => ({ id }))),
      ),
    },
    tenantMembership: {
      findFirst: jest.fn(({ where }: { where: { userId: string } }) =>
        Promise.resolve(
          opts.members.includes(where.userId) ? { userId: where.userId } : null,
        ),
      ),
    },
    notificationPreference: { findMany: jest.fn() },
  };
}

const notice = (
  over: Partial<ChatbotRequestNotice> = {},
): ChatbotRequestNotice => ({
  type: 'REQUEST_OVERDUE',
  requestId: 'r-1',
  folio: 1,
  subtype: 'UNKNOWN_QUESTION',
  dedupKey: 'k',
  ...over,
});

const resolve = (
  tx: ReturnType<typeof fakeTx>,
  n: ChatbotRequestNotice,
): Promise<Array<{ userId: string; reason: string | null }>> =>
  resolveRecipients(tx as never, 'tenant-1', n);

describe('resolveRecipients: reason (S10)', () => {
  it('a request nobody holds: every escalation holder gets ESCALATION', async () => {
    const tx = fakeTx({ holders: ['esc-1', 'esc-2'], members: [] });
    expect(await resolve(tx, notice())).toEqual([
      { userId: 'esc-1', reason: 'ESCALATION' },
      { userId: 'esc-2', reason: 'ESCALATION' },
    ]);
  });

  it('the assignee who holds no escalation grant is added with ASSIGNEE, first', async () => {
    const tx = fakeTx({ holders: ['esc-1'], members: ['ana'] });
    expect(await resolve(tx, notice({ recipientUserId: 'ana' }))).toEqual([
      { userId: 'ana', reason: 'ASSIGNEE' },
      { userId: 'esc-1', reason: 'ESCALATION' },
    ]);
  });

  it('a person who is both assignee and escalation holder gets ASSIGNEE, once', async () => {
    const tx = fakeTx({ holders: ['esc-1', 'ana'], members: ['ana'] });
    const out = await resolve(
      tx,
      notice({ type: 'REQUEST_ESCALATION', recipientUserId: 'ana' }),
    );
    expect(out).toHaveLength(2);
    expect(out).toEqual(
      expect.arrayContaining([
        { userId: 'ana', reason: 'ASSIGNEE' },
        { userId: 'esc-1', reason: 'ESCALATION' },
      ]),
    );
    // already a holder: no extra membership lookup for the assignee
    expect(tx.tenantMembership.findFirst).not.toHaveBeenCalled();
  });

  it('an assignee who is no longer an active member is not notified', async () => {
    const tx = fakeTx({ holders: ['esc-1'], members: [] });
    expect(await resolve(tx, notice({ recipientUserId: 'gone' }))).toEqual([
      { userId: 'esc-1', reason: 'ESCALATION' },
    ]);
  });

  it('the actor is never notified, in either role', async () => {
    const tx = fakeTx({ holders: ['esc-1', 'ana'], members: ['ana'] });
    expect(
      await resolve(tx, notice({ recipientUserId: 'ana', actorUserId: 'ana' })),
    ).toEqual([{ userId: 'esc-1', reason: 'ESCALATION' }]);
  });

  it.each(['REQUEST_CREATED', 'REQUEST_CLAIM_REMINDER'] as const)(
    '%s has no reason',
    async (type) => {
      const tx = fakeTx({ holders: ['h-1'], members: [] });
      expect(await resolve(tx, notice({ type }))).toEqual([
        { userId: 'h-1', reason: null },
      ]);
    },
  );

  it.each(['REQUEST_REASSIGNED', 'REQUEST_CANCELLED'] as const)(
    '%s (a named person) has no reason',
    async (type) => {
      const tx = fakeTx({ holders: [], members: ['ana'] });
      expect(
        await resolve(tx, notice({ type, recipientUserId: 'ana' })),
      ).toEqual([{ userId: 'ana', reason: null }]);
    },
  );
});
