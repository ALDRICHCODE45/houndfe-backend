/**
 * human-intervention / unit 9 — the 12-month purge of the conversation mirror
 * against REAL PostgreSQL and a fake private storage (contract §3.6, §6.2,
 * §10.1 "Purga de 12 meses"):
 *   - due messages are deleted (through the immutability trigger's retention
 *     exception), in bounded batches, idempotently, across tenants;
 *   - due files are deleted from storage first; a failed delete keeps the key
 *     and is retried like receipts retention, without starving the rest;
 *   - rows another replica holds are skipped (SKIP LOCKED) and nothing is
 *     deleted twice;
 *   - empty idle chats go; requests and their audit are never touched.
 */
import { randomUUID } from 'crypto';
import { integrationPrisma } from '../../test/integration/reset-db';
import { ConversationRetentionService } from './application/conversation-retention.service';
import { FakeMediaStorage } from './test-support/fake-media-storage';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const DAY = 86_400_000;

describeIfDb('conversation retention (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const storage = new FakeMediaStorage();
  // The purge is a system flow: it reads across tenants on the root client.
  const service = new ConversationRetentionService(
    prisma as unknown as ConstructorParameters<
      typeof ConversationRetentionService
    >[0],
    storage,
  );
  const tenants: string[] = [];

  beforeEach(() => {
    storage.objects.clear();
    storage.removed.length = 0;
    storage.failRemoveFor.clear();
  });
  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  });

  async function tenant() {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Retención', slug: `cv-ret-${id}` },
    });
    return id;
  }

  async function chat(tenantId: string, over: Record<string, unknown> = {}) {
    return prisma.chatbotConversation.create({
      data: {
        tenantId,
        conversationRef: `wa:52550${Math.floor(Math.random() * 1e8)}`,
        ...over,
      },
    });
  }

  /** Inserts directly (the app never back-dates): `ageDays` since receipt. */
  async function messages(
    tenantId: string,
    conversationId: string,
    n: number,
    opts: { dueDaysAgo?: number; fromSeq?: number; mediaId?: string } = {},
  ) {
    const due = opts.dueDaysAgo ?? 1;
    const seq0 = opts.fromSeq ?? 1;
    for (let i = 0; i < n; i++) {
      await prisma.$executeRaw`
        INSERT INTO "conversation_messages"
          ("id", "tenantId", "conversationId", "seq", "direction", "author", "type", "text",
           "mediaId", "receivedAt", "purgeAfter")
        VALUES (${randomUUID()}, ${tenantId}, ${conversationId}, ${seq0 + i}, 'IN', 'CUSTOMER',
                ${opts.mediaId ? 'IMAGE' : 'TEXT'}::"ConversationMessageType", 'hola',
                ${opts.mediaId ?? null}, now() - interval '13 months',
                now() - (${due} * interval '1 day'))`;
    }
  }
  /** Not due for another `inDays` days. */
  const freshMessages = (
    tenantId: string,
    conversationId: string,
    n: number,
    fromSeq: number,
    inDays = 30,
  ) => messages(tenantId, conversationId, n, { dueDaysAgo: -inDays, fromSeq });

  const count = (tenantId: string) =>
    prisma.conversationMessage.count({ where: { tenantId } });

  async function media(
    tenantId: string,
    over: { dueDaysAgo?: number; storageKey?: string | null } = {},
  ) {
    const id = randomUUID();
    const key =
      over.storageKey === undefined
        ? `conversation-media/${tenantId}/${id}.jpg`
        : over.storageKey;
    if (key) {
      await storage.putPrivate({
        key,
        bytes: Buffer.from('x'),
        mimeType: 'image/jpeg',
      });
    }
    await prisma.$executeRaw`
      INSERT INTO "conversation_media"
        ("id", "tenantId", "storageKey", "mimeType", "sizeBytes", "sha256",
         "idempotencyKey", "createdAt", "purgeAfter")
      VALUES (${id}, ${tenantId}, ${key}, 'image/jpeg', 1, ${'c'.repeat(64)},
              ${randomUUID()}, now() - interval '13 months',
              now() - (${over.dueDaysAgo ?? 1} * interval '1 day'))`;
    return { id, key: key as string };
  }
  const mediaRow = (id: string) =>
    prisma.conversationMedia.findUnique({ where: { id } });

  // ---------------------------------------------------------- messages

  it('deletes due messages across tenants and keeps the rest, through the trigger exception', async () => {
    const a = await tenant();
    const b = await tenant();
    const ca = await chat(a);
    const cb = await chat(b);
    await messages(a, ca.id, 3);
    await freshMessages(a, ca.id, 2, 4);
    await messages(b, cb.id, 2);
    const result = await service.purgeBatch({ batchSize: 1000 });
    expect(result.messagesDeleted).toBeGreaterThanOrEqual(5);
    expect(await count(a)).toBe(2);
    expect(await count(b)).toBe(0);
    const left = await prisma.conversationMessage.findMany({
      where: { tenantId: a },
      orderBy: { seq: 'asc' },
    });
    expect(left.map((m) => m.seq)).toEqual([4, 5]);
  });

  it('is idempotent: a second run finds nothing', async () => {
    const t = await tenant();
    const c = await chat(t);
    await messages(t, c.id, 4);
    await service.purgeBatch({ batchSize: 1000 });
    const again = await service.purgeBatch({ batchSize: 1000 });
    expect(await count(t)).toBe(0);
    expect(again.messagesDeleted).toBe(0);
  });

  it('is bounded: one call deletes at most one batch, and repeating drains everything', async () => {
    const t = await tenant();
    const c = await chat(t);
    await messages(t, c.id, 25);
    // Other tenants' due rows may exist, so count only this tenant's progress.
    const first = await service.purgeBatch({ batchSize: 10 });
    expect(first.messagesDeleted).toBeLessThanOrEqual(10);
    expect(first.hasMore).toBe(true);
    let guard = 0;
    while ((await count(t)) > 0 && guard++ < 20) {
      await service.purgeBatch({ batchSize: 10 });
    }
    expect(await count(t)).toBe(0);
  });

  it('never deletes a message that is not due, even by a month', async () => {
    const t = await tenant();
    const c = await chat(t);
    await freshMessages(t, c.id, 3, 1, 1);
    await service.purgeBatch({ batchSize: 1000 });
    expect(await count(t)).toBe(3);
  });

  it('leaves requests and their audit alone', async () => {
    const t = await tenant();
    const c = await chat(t, { conversationRef: 'wa:5215512340000' });
    await messages(t, c.id, 2);
    const request = await prisma.chatbotRequest.create({
      data: {
        tenantId: t,
        folio: 1,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        customerKey: '525512340000',
        conversationRef: 'wa:5215512340000',
        summary: 'Pregunta',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
      } as never,
    });
    await service.purgeBatch({ batchSize: 1000 });
    expect(
      await prisma.chatbotRequest.count({ where: { id: request.id } }),
    ).toBe(1);
  });

  it('skips rows another replica holds (SKIP LOCKED) and takes them on the next run', async () => {
    const t = await tenant();
    const c = await chat(t);
    await messages(t, c.id, 6);
    const [held] = await prisma.conversationMessage.findMany({
      where: { tenantId: t },
      orderBy: { seq: 'asc' },
      take: 1,
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "conversation_messages" WHERE "id" = ${held.id} FOR UPDATE`;
      locked();
      await hold;
    });
    await isLocked;
    await service.purgeBatch({ batchSize: 1000 });
    expect(await count(t)).toBe(1);
    expect(
      await prisma.conversationMessage.count({ where: { id: held.id } }),
    ).toBe(1);
    release();
    await holder;
    await service.purgeBatch({ batchSize: 1000 });
    expect(await count(t)).toBe(0);
  }, 30_000);

  it('two purges at once delete every row exactly once, with no error', async () => {
    const t = await tenant();
    const c = await chat(t);
    await messages(t, c.id, 40);
    const runs = await Promise.all([
      service.purgeBatch({ batchSize: 15 }),
      service.purgeBatch({ batchSize: 15 }),
    ]);
    expect(runs.every((r) => r.messagesDeleted >= 0)).toBe(true);
    let guard = 0;
    while ((await count(t)) > 0 && guard++ < 10) {
      await service.purgeBatch({ batchSize: 15 });
    }
    expect(await count(t)).toBe(0);
  }, 30_000);

  // ------------------------------------------------------------- media

  it('deletes the object of a due file first, then marks the row purged', async () => {
    const t = await tenant();
    const c = await chat(t);
    const m = await media(t);
    await messages(t, c.id, 1, { mediaId: m.id, dueDaysAgo: -1 }); // message not due
    const result = await service.purgeBatch({ batchSize: 1000 });
    expect(result.mediaPurged).toBeGreaterThanOrEqual(1);
    expect(storage.objects.has(m.key)).toBe(false);
    const row = await mediaRow(m.id);
    // A live message still points at it: the row stays, purged, without a key.
    expect(row).toMatchObject({ storageKey: null });
    expect(row?.purgedAt).not.toBeNull();
  });

  it('removes a purged file row once no message points at it', async () => {
    const t = await tenant();
    const c = await chat(t);
    const m = await media(t);
    await messages(t, c.id, 1, { mediaId: m.id });
    await service.purgeBatch({ batchSize: 1000 });
    expect(await mediaRow(m.id)).toBeNull();
    expect(storage.objects.has(m.key)).toBe(false);
    expect(await count(t)).toBe(0);
  });

  it('removes an orphan file (uploaded, never mirrored) and its row', async () => {
    const t = await tenant();
    const m = await media(t);
    await service.purgeBatch({ batchSize: 1000 });
    expect(storage.objects.has(m.key)).toBe(false);
    expect(await mediaRow(m.id)).toBeNull();
  });

  it('keeps a file that is not due', async () => {
    const t = await tenant();
    const m = await media(t, { dueDaysAgo: -5 });
    await service.purgeBatch({ batchSize: 1000 });
    expect(storage.objects.has(m.key)).toBe(true);
    expect((await mediaRow(m.id))?.purgedAt).toBeNull();
  });

  it('a failed delete keeps the key, counts the attempt, does not block the others, and is retried', async () => {
    const t = await tenant();
    const bad = await media(t);
    const good = await media(t);
    storage.failRemoveFor.add(bad.key);
    const runStartedAt = new Date();
    const first = await service.purgeBatch({ batchSize: 1000, runStartedAt });
    expect(first.mediaFailed).toBeGreaterThanOrEqual(1);
    expect(await mediaRow(good.id)).toBeNull();
    const failed = await mediaRow(bad.id);
    expect(failed).toMatchObject({ storageKey: bad.key, purgeAttempts: 1 });
    expect(failed?.purgedAt).toBeNull();
    expect(failed?.purgeLeaseUntil).toBeNull();
    expect(storage.objects.has(bad.key)).toBe(true);
    // The same run does not hammer it again...
    await service.purgeBatch({ batchSize: 1000, runStartedAt });
    expect((await mediaRow(bad.id))?.purgeAttempts).toBe(1);
    // ...a later run retries; once storage recovers it is gone.
    storage.failRemoveFor.clear();
    await service.purgeBatch({
      batchSize: 1000,
      runStartedAt: new Date(Date.now() + 1000),
    });
    expect(storage.objects.has(bad.key)).toBe(false);
    expect(await mediaRow(bad.id)).toBeNull();
  });

  it('rows that keep failing cannot starve newer due files', async () => {
    const t = await tenant();
    const stuck = await media(t, { dueDaysAgo: 400 });
    storage.failRemoveFor.add(stuck.key);
    await service.purgeBatch({ batchSize: 1000, runStartedAt: new Date() });
    const fresh = await media(t, { dueDaysAgo: 1 });
    // Batch of one: the never-tried (newer) row goes before the failed one.
    await service.purgeBatch({
      batchSize: 1000,
      mediaBatchSize: 1,
      runStartedAt: new Date(Date.now() + 1000),
    });
    expect(await mediaRow(fresh.id)).toBeNull();
    expect(storage.objects.has(stuck.key)).toBe(true);
  });

  it('a full batch of files that all fail is not "more to do" (no retry storm)', async () => {
    const t = await tenant();
    // Use the oldest due rows of the whole table: make this tenant's win.
    const stuck = await Promise.all(
      [1, 2].map(() => media(t, { dueDaysAgo: 3650 })),
    );
    for (const item of stuck) storage.failRemoveFor.add(item.key);
    const result = await service.purgeBatch({
      batchSize: 1000,
      mediaBatchSize: 2,
    });
    expect(result.mediaFailed).toBe(2);
    expect(result.mediaPurged).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it('refuses a key outside its tenant prefix: not deleted, counted as failed', async () => {
    const a = await tenant();
    const b = await tenant();
    const foreign = await media(a, {
      storageKey: `conversation-media/${b}/other.jpg`,
    });
    const result = await service.purgeBatch({ batchSize: 1000 });
    expect(result.mediaFailed).toBeGreaterThanOrEqual(1);
    expect(storage.objects.has(foreign.key)).toBe(true);
    expect((await mediaRow(foreign.id))?.purgeAttempts).toBe(1);
  });

  it('two purges at once never claim the same file', async () => {
    const t = await tenant();
    const items = await Promise.all(Array.from({ length: 12 }, () => media(t)));
    await Promise.all([
      service.purgeBatch({ batchSize: 1000, mediaBatchSize: 6 }),
      service.purgeBatch({ batchSize: 1000, mediaBatchSize: 6 }),
    ]);
    await service.purgeBatch({ batchSize: 1000, mediaBatchSize: 12 });
    for (const item of items) {
      expect(storage.objects.has(item.key)).toBe(false);
      expect(await mediaRow(item.id)).toBeNull();
    }
    // Each object was removed once by the claim, never twice.
    const removed = storage.removed.filter((k) =>
      items.some((i) => i.key === k),
    );
    expect(new Set(removed).size).toBe(removed.length);
  }, 30_000);

  // ------------------------------------------------------ conversations

  it('deletes an emptied, idle bot-mode chat; keeps one with messages, in human mode, or just used', async () => {
    const t = await tenant();
    const old = new Date(Date.now() - 3 * DAY);
    const emptied = await chat(t);
    const stays = await chat(t);
    const human = await chat(t, { mode: 'HUMAN' });
    const recent = await chat(t);
    await messages(t, emptied.id, 2);
    await messages(t, human.id, 1);
    await messages(t, recent.id, 1);
    await freshMessages(t, stays.id, 1, 1);
    // `updatedAt` is Prisma-managed: age three of them directly.
    await prisma.$executeRaw`UPDATE "chatbot_conversations" SET "updatedAt" = ${old}
      WHERE "id" IN (${emptied.id}, ${stays.id}, ${human.id})`;
    const result = await service.purgeBatch({ batchSize: 1000 });
    expect(result.conversationsDeleted).toBeGreaterThanOrEqual(1);
    const ids = (
      await prisma.chatbotConversation.findMany({ where: { tenantId: t } })
    ).map((c) => c.id);
    expect(ids.sort()).toEqual([stays.id, human.id, recent.id].sort());
  });

  // ------------------------------- fix-forward sweep of message-less chats

  describe('sweepEmptyChats: an emptied chat is never stranded', () => {
    const idle = (ids: string[], days = 3) =>
      prisma.$executeRaw`UPDATE "chatbot_conversations"
        SET "updatedAt" = now() - (${days} * interval '1 day')
        WHERE "id" = ANY(${ids}::text[])`;
    const exists = async (id: string) =>
      (await prisma.chatbotConversation.count({ where: { id } })) === 1;

    async function requestFor(tenantId: string, ref: string) {
      await prisma.chatbotRequest.create({
        data: {
          tenantId,
          folio: Math.floor(Math.random() * 1e6),
          kind: 'CLARIFICATION',
          subtype: 'UNKNOWN_QUESTION',
          customerKey: ref.slice(3),
          conversationRef: ref,
          summary: 'Pregunta',
          source: 'chatbot',
          sourceRequestId: randomUUID(),
          status: 'CANCELLED',
          cancelReason: 'CUSTOMER_WITHDREW',
          cancelledAt: new Date(),
          closedAt: new Date(),
        } as never,
      });
    }

    it('revisits a chat whose inline cleanup threw AFTER the message delete committed', async () => {
      const t = await tenant();
      const stranded = await chat(t);
      await messages(t, stranded.id, 2);
      await idle([stranded.id]);
      jest
        .spyOn(
          service as unknown as { deleteEmptyChats: () => Promise<number> },
          'deleteEmptyChats',
        )
        .mockRejectedValueOnce(new Error('db blip after commit'));
      await expect(service.purgeBatch({ batchSize: 1000 })).rejects.toThrow(
        'db blip',
      );
      jest.restoreAllMocks();
      // Committed: the messages are gone and the chat survived the failure.
      expect(await count(t)).toBe(0);
      expect(await exists(stranded.id)).toBe(true);
      // The next purge batch (no message left to return the chat) cannot see
      // it; the sweep does.
      await service.purgeBatch({ batchSize: 1000 });
      expect(await exists(stranded.id)).toBe(true);
      const swept = await service.sweepEmptyChats();
      expect(swept.deleted).toBeGreaterThanOrEqual(1);
      expect(await exists(stranded.id)).toBe(false);
    });

    it('revisits a chat that SKIP LOCKED skipped, once the lock is gone', async () => {
      const t = await tenant();
      const locked = await chat(t);
      await idle([locked.id]);
      let release!: () => void;
      let ready!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const taken = new Promise<void>((r) => (ready = r));
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "chatbot_conversations" WHERE "id" = ${locked.id} FOR UPDATE`;
        ready();
        await held;
      });
      await taken;
      await service.sweepEmptyChats();
      expect(await exists(locked.id)).toBe(true);
      release();
      await holder;
      await service.sweepEmptyChats();
      expect(await exists(locked.id)).toBe(false);
    });

    it('revisits a chat that was not yet a day idle when its messages went', async () => {
      const t = await tenant();
      const young = await chat(t);
      await messages(t, young.id, 1);
      await idle([young.id], 0); // updatedAt = now(): idle for no time
      await service.purgeBatch({ batchSize: 1000 });
      expect(await count(t)).toBe(0);
      expect(await exists(young.id)).toBe(true);
      await service.sweepEmptyChats();
      expect(await exists(young.id)).toBe(true); // still not idle a day
      await idle([young.id], 2);
      await service.sweepEmptyChats();
      expect(await exists(young.id)).toBe(false);
    });

    it('keeps what must stay: messages, human mode, a request pointing at it (N3)', async () => {
      const t = await tenant();
      const withMessage = await chat(t);
      const human = await chat(t, { mode: 'HUMAN' });
      const referenced = await chat(t);
      await freshMessages(t, withMessage.id, 1, 1);
      await requestFor(t, referenced.conversationRef);
      await idle([withMessage.id, human.id, referenced.id]);
      await service.sweepEmptyChats();
      expect(await exists(withMessage.id)).toBe(true);
      expect(await exists(human.id)).toBe(true);
      expect(await exists(referenced.id)).toBe(true);
      // The reference is per tenant: the same ref in another tenant does not
      // protect this tenant's chat.
      const other = await tenant();
      const twin = await chat(other, {
        conversationRef: referenced.conversationRef,
      });
      await idle([twin.id]);
      await service.sweepEmptyChats();
      expect(await exists(twin.id)).toBe(false);
      expect(await exists(referenced.id)).toBe(true);
    });

    it('is bounded: one call deletes at most one batch and says there is more', async () => {
      const t = await tenant();
      const chats = [await chat(t), await chat(t), await chat(t)];
      await idle(chats.map((c) => c.id));
      // Other specs may leave their own idle chats: look at ours only.
      let calls = 0;
      let first: { deleted: number; hasMore: boolean } | null = null;
      while (
        (await prisma.chatbotConversation.count({ where: { tenantId: t } })) > 0
      ) {
        const r = await service.sweepEmptyChats({ batchSize: 1 });
        first ??= r;
        expect(r.deleted).toBeLessThanOrEqual(1);
        calls += 1;
        if (calls > 5000) throw new Error('sweep does not drain');
      }
      expect(first).toEqual({ deleted: 1, hasMore: true });
    }, 60_000);

    it('two sweeps at once delete each chat once, with no error', async () => {
      const t = await tenant();
      const chats = [
        await chat(t),
        await chat(t),
        await chat(t),
        await chat(t),
      ];
      await idle(chats.map((c) => c.id));
      const results = await Promise.all([
        service.sweepEmptyChats(),
        service.sweepEmptyChats(),
      ]);
      expect(results.every((r) => r.deleted >= 0)).toBe(true);
      expect(
        await prisma.chatbotConversation.count({ where: { tenantId: t } }),
      ).toBe(0);
    });
  });
});

// The shared client keeps a pool open for the whole run unless it is closed:
// the integration suite runs every spec in one process against one database.
afterAll(async () => {
  await integrationPrisma().$disconnect();
});
