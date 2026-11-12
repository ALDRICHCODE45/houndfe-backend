/* eslint-disable @typescript-eslint/no-unsafe-assignment -- SSE payloads are untyped JSON */
/**
 * human-intervention / unit 9 — `conversation.message` and `message.status`
 * through the REAL stream (real HTTP SSE client, real guards, hub, log, LISTEN
 * connection) against PostgreSQL (contract §5.3, §12.8, R12). The events are
 * written by the mirror store in the transaction of the write; the frame each
 * recipient gets is built at delivery:
 *   - only people with read:ChatbotConversation receive them;
 *   - they carry {requestId, message} / {requestId, messageId, seq,
 *     deliveryStatus} and never the chat reference or a phone number;
 *   - a reconnect with Last-Event-ID replays them in order;
 *   - tenants are isolated.
 */
import { randomUUID } from 'crypto';
import { PrismaConversationMirrorStore } from '../conversations/infrastructure/prisma-conversation-mirror.store';
import type { ParsedMessage } from '../conversations/domain/conversation-message';
import { SseClient } from './test-support/sse-client';
import {
  MANAGER,
  createStreamHarness,
  type StreamHarness,
} from './test-support/stream-harness';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const REF = 'wa:5215512345678';
const LEAK = /(?<![0-9A-Za-z-])\+?\d{10,15}(?![0-9A-Za-z-])|wa:/;
const messageText = (data: unknown) =>
  (data as { message: { text: string } }).message.text;
const requestIdOf = (data: unknown) =>
  (data as { requestId: string }).requestId;
const WITH_CONVERSATION = [
  ...MANAGER,
  ['ChatbotConversation', 'read'] as [string, string],
];

describeIfDb('realtime conversation events (PostgreSQL, real HTTP)', () => {
  let h: StreamHarness;
  let mirror: PrismaConversationMirrorStore;
  const clients: SseClient[] = [];

  beforeAll(async () => {
    h = await createStreamHarness({ accessCacheMs: 0 });
    mirror = new PrismaConversationMirrorStore(h.tenantPrisma);
  }, 60_000);
  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });
  afterAll(async () => {
    await h.close();
  });

  const connect = async (
    tenantId: string,
    userId: string,
    after?: string,
  ): Promise<SseClient> => {
    const client = new SseClient();
    clients.push(client);
    await client.open(
      h.baseUrl,
      '/realtime/stream',
      h.headers(tenantId, userId, after ? { 'last-event-id': after } : {}),
    );
    // A connection with a cursor replays instead of saying `ready`.
    if (!after) await client.waitForEvent('ready');
    return client;
  };

  const message = (over: Partial<ParsedMessage> = {}): ParsedMessage => ({
    waMessageId: `wamid.${randomUUID()}`,
    direction: 'IN',
    author: 'CUSTOMER',
    type: 'TEXT',
    text: 'Hola, ¿tienen croquetas?',
    mediaId: null,
    providerTimestamp: new Date(),
    observedAt: new Date(),
    ...over,
  });
  const ingest = (tenantId: string, messages: ParsedMessage[], ref = REF) =>
    h.cls.runWith({ tenantId, userId: 'bot', isSuperAdmin: false }, () =>
      mirror.ingest({
        conversationRef: ref,
        customerKey: '525512345678',
        messages,
      }),
    );
  const statuses = (
    tenantId: string,
    list: Array<{ providerMessageId: string; status: 'DELIVERED' | 'READ' }>,
  ) =>
    h.cls.runWith({ tenantId, userId: 'bot', isSuperAdmin: false }, () =>
      mirror.applyStatuses(list),
    );

  async function world() {
    const tenantId = await h.seedTenant();
    const manager = await h.seedUser(tenantId, WITH_CONVERSATION, {
      name: 'Marta',
    });
    const noConversation = await h.seedUser(tenantId, MANAGER, {
      name: 'Caro',
    });
    const request = await h.seedRequest(tenantId, { conversationRef: REF });
    return { tenantId, manager, noConversation, request };
  }

  it('delivers conversation.message to a reader with read:ChatbotConversation, with the full message and no chat reference', async () => {
    const w = await world();
    const client = await connect(w.tenantId, w.manager.userId);
    await ingest(w.tenantId, [message({ text: 'primero' })]);
    await client.waitForEvent('conversation.message');
    const [event] = client.of('conversation.message');
    expect(event.data).toEqual({
      requestId: w.request.id,
      message: expect.objectContaining({
        seq: 1,
        direction: 'IN',
        author: 'CUSTOMER',
        type: 'TEXT',
        text: 'primero',
        deliveryStatus: null,
      }),
    });
    expect(JSON.stringify(event.data)).not.toMatch(LEAK);
  });

  it('a reader without read:ChatbotConversation gets neither event, but keeps their stream', async () => {
    const w = await world();
    const allowed = await connect(w.tenantId, w.manager.userId);
    const denied = await connect(w.tenantId, w.noConversation.userId);
    await ingest(w.tenantId, [
      message(),
      message({ direction: 'OUT', author: 'BOT' }),
    ]);
    await allowed.waitForEvent('conversation.message', 2);
    expect(allowed.of('conversation.message')).toHaveLength(2);
    // The denied stream is still alive: a request event reaches it.
    await h.command(w.tenantId, w.noConversation.userId, w.request.id, 1, {
      kind: 'claim',
    });
    await denied.waitForEvent('request.claimed');
    expect(denied.of('conversation.message')).toEqual([]);
    expect(denied.of('message.status')).toEqual([]);
  });

  it('message.status carries the status, and a repeated status sends nothing', async () => {
    const w = await world();
    const client = await connect(w.tenantId, w.manager.userId);
    const out = message({ direction: 'OUT', author: 'BOT', text: 'Claro' });
    await ingest(w.tenantId, [out]);
    await client.waitForEvent('conversation.message');
    await statuses(w.tenantId, [
      { providerMessageId: out.waMessageId, status: 'DELIVERED' },
    ]);
    await statuses(w.tenantId, [
      { providerMessageId: out.waMessageId, status: 'DELIVERED' },
    ]);
    await statuses(w.tenantId, [
      { providerMessageId: out.waMessageId, status: 'READ' },
    ]);
    await client.waitForEvent('message.status', 2);
    const frames = client.of('message.status').map((m) => m.data);
    expect(frames).toHaveLength(2);
    // Built from the current row: both frames may show the latest status, and
    // they always identify the message and its seq.
    for (const frame of frames) {
      expect(frame).toMatchObject({
        requestId: w.request.id,
        seq: 1,
        deliveryStatus: expect.stringMatching(/DELIVERED|READ/),
      });
    }
    expect(frames.at(-1)).toMatchObject({ deliveryStatus: 'READ' });
  });

  it('replays what was missed, in seq order, when the client reconnects with Last-Event-ID', async () => {
    const w = await world();
    const first = await connect(w.tenantId, w.manager.userId);
    await ingest(w.tenantId, [message({ text: 'uno' })]);
    await first.waitForEvent('conversation.message');
    const lastId = first.of('conversation.message')[0].id as string;
    first.close();
    await ingest(w.tenantId, [
      message({ text: 'dos' }),
      message({ text: 'tres' }),
    ]);
    const second = await connect(w.tenantId, w.manager.userId, lastId);
    await second.waitForEvent('conversation.message', 2);
    const texts = second
      .of('conversation.message')
      .map((m) => messageText(m.data));
    expect(texts).toEqual(['dos', 'tres']);
  });

  it('one event per open request of the chat; a closed request and another chat get none', async () => {
    const w = await world();
    const second = await h.seedRequest(w.tenantId, { conversationRef: REF });
    await h.seedRequest(w.tenantId, { conversationRef: 'wa:5215500000000' });
    const client = await connect(w.tenantId, w.manager.userId);
    await ingest(w.tenantId, [message()]);
    await client.waitForEvent('conversation.message', 2);
    const requestIds = client
      .of('conversation.message')
      .map((m) => requestIdOf(m.data));
    expect(new Set(requestIds)).toEqual(new Set([w.request.id, second.id]));
  });

  it('is tenant isolated: another tenant never sees the messages, even for the same chat reference', async () => {
    const a = await world();
    const b = await world();
    const clientB = await connect(b.tenantId, b.manager.userId);
    await ingest(a.tenantId, [message({ text: 'solo de A' })]);
    await ingest(b.tenantId, [message({ text: 'solo de B' })]);
    await clientB.waitForEvent('conversation.message');
    const texts = clientB
      .of('conversation.message')
      .map((m) => messageText(m.data));
    expect(texts).toEqual(['solo de B']);
  });
});
