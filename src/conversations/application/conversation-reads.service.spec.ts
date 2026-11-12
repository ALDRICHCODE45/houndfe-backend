/**
 * S12 at the service seam: WHEN the staff read moves the chat's read marker.
 * (The counter itself and the realtime events are proved against PostgreSQL in
 * `conversation-unread.integration.spec.ts`.)
 */
import { InsufficientPermissionsError } from '../../shared/domain/domain-error';
import type { MessageRecord } from '../domain/message-view';
import {
  ConversationReadsService,
  type ConversationReadStore,
  type ConversationRequestRef,
} from './conversation-reads.service';

const row = (seq: number): MessageRecord => ({
  id: `m-${seq}`,
  seq,
  direction: 'IN',
  author: 'CUSTOMER',
  staffUserId: null,
  type: 'TEXT',
  text: 'hola',
  mediaId: null,
  clientMessageId: null,
  providerTimestamp: new Date('2026-11-12T10:00:00Z'),
  receivedAt: new Date('2026-11-12T10:00:00Z'),
  deliveryStatus: null,
});

const abilityOf = (...grants: string[]) => ({
  can: (action: string, subject: string) =>
    grants.includes(`${action}:${subject}`),
});
const READER = abilityOf('read:ChatbotRequest', 'read:ChatbotConversation');
const ATTENDEE = abilityOf('read:ChatbotRequest');

function build(
  request: Partial<ConversationRequestRef> = {},
  rows: MessageRecord[] = [row(1), row(2), row(3)],
  markRead: jest.Mock = jest.fn().mockResolvedValue(true),
  sessionStartSeq: number | null = null,
) {
  const page = jest.fn().mockResolvedValue({ rows, hasMoreBefore: false });
  const store: ConversationReadStore = {
    findRequest: jest.fn().mockResolvedValue({
      id: 'r-1',
      status: 'NEW',
      conversationRef: 'wa:5215512345678',
      assigneeUserId: null,
      ...request,
    }),
    page,
    markRead,
    sessionStartSeq: jest.fn().mockResolvedValue(sessionStartSeq),
    media: jest.fn().mockResolvedValue([]),
    users: jest.fn().mockResolvedValue([]),
  };
  return {
    service: new ConversationReadsService(store),
    store,
    page,
    markRead,
  };
}

describe('ConversationReadsService, attendee without read:ChatbotConversation (unit 11, §2.5)', () => {
  it('sees only the messages of their own session, from its first seq, and moves no marker', async () => {
    const {
      service,
      page: pageMock,
      markRead,
    } = build(
      { status: 'IN_PROGRESS', assigneeUserId: 'u-2' },
      [row(5), row(6)],
      undefined,
      5,
    );
    const page = await service.page(
      { userId: 'u-2', ability: ATTENDEE },
      'r-1',
      {},
    );
    expect(page.items.map((m) => m.seq)).toEqual([5, 6]);
    expect(pageMock).toHaveBeenCalledWith(
      'wa:5215512345678',
      expect.anything(),
      5,
    );
    expect(markRead).not.toHaveBeenCalled();
  });

  it('a full reader is not limited to a session', async () => {
    const { service, page: pageMock } = build({}, undefined, undefined, 5);
    await service.page({ userId: 'u-1', ability: READER }, 'r-1', {});
    expect(pageMock).toHaveBeenCalledWith(
      'wa:5215512345678',
      expect.anything(),
      undefined,
    );
  });
});

describe('ConversationReadsService, S12 read marker', () => {
  it('moves the marker to the newest message the page showed', async () => {
    const { service, markRead } = build();
    const page = await service.page(
      { userId: 'u-1', ability: READER },
      'r-1',
      {},
    );
    expect(page.items).toHaveLength(3);
    expect(markRead).toHaveBeenCalledWith('wa:5215512345678', 3);
  });

  it('an assignee without read:ChatbotConversation and with no session gets the empty page and moves nothing', async () => {
    const { service, markRead } = build({
      status: 'IN_PROGRESS',
      assigneeUserId: 'u-2',
    });
    const page = await service.page(
      { userId: 'u-2', ability: ATTENDEE },
      'r-1',
      {},
    );
    expect(page).toEqual({ items: [], hasMoreBefore: false });
    expect(markRead).not.toHaveBeenCalled();
  });

  it('a 403 moves nothing', async () => {
    const { service, markRead } = build();
    await expect(
      service.page({ userId: 'u-3', ability: ATTENDEE }, 'r-1', {}),
    ).rejects.toBeInstanceOf(InsufficientPermissionsError);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('an empty page, or a request with no chat, moves nothing', async () => {
    const empty = build({}, []);
    await empty.service.page({ userId: 'u-1', ability: READER }, 'r-1', {});
    expect(empty.markRead).not.toHaveBeenCalled();
    const noChat = build({ conversationRef: null });
    await noChat.service.page({ userId: 'u-1', ability: READER }, 'r-1', {});
    expect(noChat.markRead).not.toHaveBeenCalled();
  });

  it('a failure to move the marker never fails the read', async () => {
    const { service } = build(
      {},
      undefined,
      jest.fn().mockRejectedValue(new Error('db busy')),
    );
    const page = await service.page(
      { userId: 'u-1', ability: READER },
      'r-1',
      {},
    );
    expect(page.items).toHaveLength(3);
  });
});
