/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON */
/**
 * human-intervention / unit 9 verify fixes — the LIFE of a stored object against
 * REAL PostgreSQL and the fake private storage:
 *
 *   S2  every object ends up purged inside the 12-month bound:
 *       (a) a crash between the storage write and the row insert,
 *       (b) a failed delete after an insert failure / a lost race (the adapter's
 *           `delete` swallows errors; the conversation path uses `remove`),
 *       (c) a tenant deletion that cascades the rows and used to leave the files,
 *       (d) objects nothing owns (bucket sweep: bounded, resumable, prefix-guarded).
 *   N4  a file referenced by a later message is purged with its LAST reference,
 *       and a purge in progress cannot be referenced.
 *   N3  an emptied chat that a request points at keeps its row (and `nextSeq`).
 */
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'crypto';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../test/integration/reset-db';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import { PrismaServiceCredentialRepository } from '../chatbot-api/infrastructure/prisma-service-credential.repository';
import { BotRateLimitModule } from '../chatbot-api/presentation/guards/bot-rate-limit.module';
import { ServiceAuthGuard } from '../chatbot-api/presentation/guards/service-auth.guard';
import { ChatbotRequestHttpFilter } from '../chatbot-requests/presentation/chatbot-request-http.filter';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import {
  CONVERSATION_MEDIA_STORAGE,
  CONVERSATION_MEDIA_STORE,
  ConversationMediaService,
} from './application/conversation-media.service';
import {
  CONVERSATION_MIRROR_STORE,
  ConversationMirrorService,
} from './application/conversation-mirror.service';
import { ConversationRetentionService } from './application/conversation-retention.service';
import { PrismaConversationMediaStore } from './infrastructure/prisma-conversation-media.store';
import { PrismaConversationMirrorStore } from './infrastructure/prisma-conversation-mirror.store';
import { BotConversationController } from './presentation/bot-conversation.controller';
import { BotMediaController } from './presentation/bot-media.controller';
import { FakeMediaStorage } from './test-support/fake-media-storage';
import { StubGuard, StubPermissionsGuard } from './test-support/staff-stubs';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const DAY = 86_400_000;
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(252, 0x61),
]);
const NOW = () => new Date().toISOString();

describeIfDb('conversation media lifecycle (PostgreSQL, fake storage)', () => {
  const prisma = integrationPrisma();
  const storage = new FakeMediaStorage();
  const retention = new ConversationRetentionService(
    prisma as unknown as ConstructorParameters<
      typeof ConversationRetentionService
    >[0],
    storage,
    storage,
  );
  let app: INestApplication;
  const tenants: string[] = [];
  const credentials: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BotRateLimitModule,
      ],
      controllers: [BotMediaController, BotConversationController],
      providers: [
        ServiceAuthGuard,
        ChatbotRequestHttpFilter,
        ConversationMediaService,
        ConversationMirrorService,
        {
          provide: CONVERSATION_MEDIA_STORE,
          useClass: PrismaConversationMediaStore,
        },
        { provide: CONVERSATION_MEDIA_STORAGE, useValue: storage },
        {
          provide: CONVERSATION_MIRROR_STORE,
          useClass: PrismaConversationMirrorStore,
        },
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useClass: PrismaServiceCredentialRepository,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(StubGuard)
      .overrideGuard(TenantContextGuard)
      .useClass(StubGuard)
      .overrideGuard(ActiveUserGuard)
      .useClass(StubGuard)
      .overrideGuard(PermissionsGuard)
      .useClass(StubPermissionsGuard)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
  }, 60_000);

  beforeEach(() => {
    storage.objects.clear();
    storage.removed.length = 0;
    storage.failPut = false;
    storage.failRemoveAll = false;
    storage.failRemoveFor.clear();
    storage.failList = false;
    storage.listCalls.length = 0;
    storage.putDelayMs = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    await prisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: credentials } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.$executeRaw`DELETE FROM "conversation_media_intents" WHERE "tenantId" = ANY(${tenants}::text[])`; // The shared client would otherwise keep its pool open for the whole run.
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------- helpers

  async function bot() {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Ciclo', slug: `cv-life-${id}` },
    });
    const token = `svc_${randomUUID()}`;
    const credential = await prisma.serviceCredential.create({
      data: {
        tenantId: id,
        name: 'bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes: ['media:write', 'conversation:write'],
        rateLimit: 600,
      },
    });
    credentials.push(credential.id);
    return { tenantId: id, token };
  }
  type Bot = Awaited<ReturnType<typeof bot>>;

  const upload = (b: Bot, key: string = randomUUID()) =>
    request(app.getHttpServer())
      .post('/chatbot-api/media')
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Branch-Id', b.tenantId)
      .set('X-Idempotency-Key', key)
      .attach('file', JPEG, {
        filename: 'f.bin',
        contentType: 'application/octet-stream',
      });

  const imageMessage = (mediaId: string) => ({
    waMessageId: `wamid.${randomUUID()}`,
    direction: 'IN',
    type: 'IMAGE',
    mediaId,
    providerTimestamp: NOW(),
    observedAt: NOW(),
  });
  const postMessages = (b: Bot, ref: string, messages: unknown[]) =>
    request(app.getHttpServer())
      .post(
        `/chatbot-api/conversations/${encodeURIComponent(ref)}/messages:batch`,
      )
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Branch-Id', b.tenantId)
      .send({ messages });

  const intents = (tenantId: string) =>
    prisma.$queryRaw<
      Array<{
        id: string;
        storageKey: string;
        reason: string;
        attempts: number;
        dueAt: Date;
      }>
    >`SELECT "id", "storageKey", "reason", "attempts", "dueAt"
      FROM "conversation_media_intents" WHERE "tenantId" = ${tenantId}
      ORDER BY "createdAt"`;
  const makeDue = (tenantId: string) =>
    prisma.$executeRaw`UPDATE "conversation_media_intents"
      SET "dueAt" = now() - interval '1 minute' WHERE "tenantId" = ${tenantId}`;
  const mediaRows = (tenantId: string) =>
    prisma.conversationMedia.findMany({ where: { tenantId } });
  const sweep = () =>
    retention.purgeBatch({ batchSize: 1000, runStartedAt: new Date() });

  /** An object plus (optionally) its row, inserted directly. */
  async function seededMedia(
    tenantId: string,
    over: { row?: boolean; purgeAfterSql?: 'future' | 'soon' } = {},
  ) {
    const id = randomUUID();
    const key = `conversation-media/${tenantId}/${id}.jpg`;
    await storage.putPrivate({ key, bytes: JPEG, mimeType: 'image/jpeg' });
    if (over.row !== false) {
      await prisma.$executeRaw`
        INSERT INTO "conversation_media"
          ("id", "tenantId", "storageKey", "mimeType", "sizeBytes", "sha256",
           "idempotencyKey", "createdAt", "purgeAfter")
        VALUES (${id}, ${tenantId}, ${key}, 'image/jpeg', 256, ${'a'.repeat(64)},
                ${randomUUID()}, now(),
                ${over.purgeAfterSql === 'soon' ? new Date(Date.now() + 2_000) : new Date(Date.now() + 30 * DAY)})`;
    }
    return { id, key };
  }

  // ------------------------------------------------------- S2 (a) crash

  describe('S2 (a): a crash between the storage write and the row insert', () => {
    it('the intent is durable BEFORE the object is written, and dropped once a row owns it', async () => {
      const b = await bot();
      storage.putDelayMs = 400;
      const pending = upload(b).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Mid-upload: the object is not stored yet, the intent already is.
      const during = await intents(b.tenantId);
      expect(during).toHaveLength(1);
      expect(during[0]).toMatchObject({ reason: 'UPLOAD', attempts: 0 });
      expect(during[0].storageKey).toMatch(
        new RegExp(`^conversation-media/${b.tenantId}/${during[0].id}\\.jpg$`),
      );
      const res = await pending;
      expect(res.status).toBe(201);
      expect(await intents(b.tenantId)).toEqual([]);
      expect((await mediaRows(b.tenantId))[0].storageKey).toBe(
        during[0].storageKey,
      );
    });

    it('a process that died after the write leaves an intent the sweep turns into a deleted object', async () => {
      const b = await bot();
      // What a dead upload leaves: the intent and the object, no row.
      const id = randomUUID();
      const key = `conversation-media/${b.tenantId}/${id}.jpg`;
      await prisma.$executeRaw`
        INSERT INTO "conversation_media_intents" ("id", "tenantId", "storageKey", "reason", "dueAt")
        VALUES (${id}, ${b.tenantId}, ${key}, 'UPLOAD', now() + interval '1 hour')`;
      await storage.putPrivate({ key, bytes: JPEG, mimeType: 'image/jpeg' });
      // Not due yet: an upload may still be in flight, so nothing is touched.
      await sweep();
      expect(storage.objects.has(key)).toBe(true);
      expect(await intents(b.tenantId)).toHaveLength(1);
      await makeDue(b.tenantId);
      const result = await sweep();
      expect(result.intentsSettled).toBeGreaterThanOrEqual(1);
      expect(storage.objects.has(key)).toBe(false);
      expect(await intents(b.tenantId)).toEqual([]);
    });

    it('an intent whose upload DID finish is dropped without touching the object', async () => {
      const b = await bot();
      const { id, key } = await seededMedia(b.tenantId);
      await prisma.$executeRaw`
        INSERT INTO "conversation_media_intents" ("id", "tenantId", "storageKey", "reason", "dueAt")
        VALUES (${id}, ${b.tenantId}, ${key}, 'UPLOAD', now() - interval '1 minute')`;
      await sweep();
      expect(await intents(b.tenantId)).toEqual([]);
      expect(storage.objects.has(key)).toBe(true);
      expect(await mediaRows(b.tenantId)).toHaveLength(1);
    });
  });

  // ------------------------------------------- S2 (b) swallowed deletes

  describe('S2 (b): a failed delete after an insert failure or a lost race', () => {
    it('an insert that rejects deletes nothing inline: the object and intent wait for the sweep, which purges the object (no row) and retries a failed delete', async () => {
      const b = await bot();
      jest
        .spyOn(PrismaConversationMediaStore.prototype, 'insert')
        .mockRejectedValueOnce(new Error('db down'));
      await upload(b).expect(500);
      // Ambiguous failure: no inline delete, whatever the storage state.
      expect(storage.removed).toEqual([]);
      const [left] = await intents(b.tenantId);
      expect(storage.objects.has(left.storageKey)).toBe(true);
      expect(await mediaRows(b.tenantId)).toEqual([]);

      storage.failRemoveAll = true;
      await makeDue(b.tenantId);
      const stillDown = await sweep();
      expect(stillDown.intentsFailed).toBeGreaterThanOrEqual(1);
      expect(storage.objects.has(left.storageKey)).toBe(true);
      expect((await intents(b.tenantId))[0].attempts).toBe(1);

      storage.failRemoveAll = false;
      // A later run retries it (the failed row waits for the next run stamp).
      await retention.purgeBatch({
        batchSize: 1000,
        runStartedAt: new Date(Date.now() + 1_000),
      });
      expect(storage.objects.has(left.storageKey)).toBe(false);
      expect(await intents(b.tenantId)).toEqual([]);
    });

    it('an insert that COMMITS and then rejects keeps its object: the retry replays a readable row and the sweep only drops the intent', async () => {
      const b = await bot();
      const key = randomUUID();
      // Called back with the right `this` below, through `.call`.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const real = PrismaConversationMediaStore.prototype.insert;
      jest
        .spyOn(PrismaConversationMediaStore.prototype, 'insert')
        .mockImplementationOnce(async function (
          this: PrismaConversationMediaStore,
          row,
        ) {
          await real.call(this, row); // autocommitted
          throw new Error('connection reset');
        });
      await upload(b, key).expect(500);
      const [row] = await mediaRows(b.tenantId);
      expect(row).toBeDefined();
      expect(storage.objects.has(row.storageKey as string)).toBe(true);
      expect(storage.removed).toEqual([]);

      // The bot retries with the same key: it gets the row, whose file exists.
      const replay = await upload(b, key).expect(200);
      expect((replay.body as { mediaId: string }).mediaId).toBe(row.id);
      expect(storage.objects.has(row.storageKey as string)).toBe(true);

      // The sweep sees a row for the id: the object stays, the intent goes.
      await makeDue(b.tenantId);
      await sweep();
      expect(storage.objects.has(row.storageKey as string)).toBe(true);
      expect(await intents(b.tenantId)).toEqual([]);
    });

    it('a lost race whose delete fails leaves an intent for the loser only', async () => {
      const b = await bot();
      storage.putDelayMs = 80;
      storage.failRemoveAll = true;
      const key = randomUUID();
      const [x, y] = await Promise.all([upload(b, key), upload(b, key)]);
      expect([x.status, y.status].sort()).toEqual([200, 201]);
      const rows = await mediaRows(b.tenantId);
      expect(rows).toHaveLength(1);
      // Two objects were written; one is owned, the loser's is pending purge.
      expect(storage.objects.size).toBe(2);
      const pending = await intents(b.tenantId);
      expect(pending).toHaveLength(1);
      expect(pending[0].storageKey).not.toBe(rows[0].storageKey);

      storage.failRemoveAll = false;
      await makeDue(b.tenantId);
      await sweep();
      expect([...storage.objects.keys()]).toEqual([rows[0].storageKey]);
      expect(await intents(b.tenantId)).toEqual([]);
    });

    it('a failed write leaves no intent (nothing was stored)', async () => {
      const b = await bot();
      storage.failPut = true;
      await upload(b).expect(503);
      expect(await intents(b.tenantId)).toEqual([]);
    });

    it('a failed write whose cleanup also fails keeps the intent (a timeout may have written it)', async () => {
      const b = await bot();
      storage.failPut = true;
      storage.failRemoveAll = true;
      await upload(b).expect(503);
      expect(await intents(b.tenantId)).toHaveLength(1);
    });
  });

  // -------------------------------------------- S2 (c) tenant deletion

  describe('S2 (c): a tenant deletion cascades the rows, not the files', () => {
    it('leaves a tombstone per owned object and the sweep deletes the files', async () => {
      const b = await bot();
      const one = await seededMedia(b.tenantId);
      const two = await seededMedia(b.tenantId);
      // A purged row owns nothing and writes no tombstone.
      const purgedId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "conversation_media"
          ("id", "tenantId", "storageKey", "mimeType", "sizeBytes", "sha256",
           "idempotencyKey", "purgeAfter", "purgedAt")
        VALUES (${purgedId}, ${b.tenantId}, NULL, 'image/jpeg', 1, ${'b'.repeat(64)},
                ${randomUUID()}, now(), now())`;
      await prisma.tenant.delete({ where: { id: b.tenantId } });
      expect(
        await prisma.conversationMedia.count({
          where: { tenantId: b.tenantId },
        }),
      ).toBe(0);
      const tombstones = await intents(b.tenantId);
      expect(tombstones.map((t) => t.id).sort()).toEqual(
        [one.id, two.id].sort(),
      );
      expect(tombstones.every((t) => t.reason === 'ROW_DELETED')).toBe(true);
      // Due at once, and it outlived its tenant (no foreign key).
      const result = await sweep();
      expect(result.intentsSettled).toBeGreaterThanOrEqual(2);
      expect(storage.objects.has(one.key)).toBe(false);
      expect(storage.objects.has(two.key)).toBe(false);
      expect(await intents(b.tenantId)).toEqual([]);
    });

    it('a failed delete keeps the tombstone and is retried', async () => {
      const b = await bot();
      const one = await seededMedia(b.tenantId);
      await prisma.tenant.delete({ where: { id: b.tenantId } });
      storage.failRemoveFor.add(one.key);
      await sweep();
      expect(storage.objects.has(one.key)).toBe(true);
      expect(await intents(b.tenantId)).toHaveLength(1);
      storage.failRemoveFor.clear();
      await retention.purgeBatch({
        batchSize: 1000,
        runStartedAt: new Date(Date.now() + 1_000),
      });
      expect(storage.objects.has(one.key)).toBe(false);
      expect(await intents(b.tenantId)).toEqual([]);
    });

    it('never deletes a key outside the tombstone tenant prefix', async () => {
      const a = await bot();
      const other = await bot();
      const foreign = `conversation-media/${other.tenantId}/${randomUUID()}.jpg`;
      await storage.putPrivate({
        key: foreign,
        bytes: JPEG,
        mimeType: 'image/jpeg',
      });
      await prisma.$executeRaw`
        INSERT INTO "conversation_media_intents" ("id", "tenantId", "storageKey", "reason", "dueAt")
        VALUES (${randomUUID()}, ${a.tenantId}, ${foreign}, 'ROW_DELETED', now() - interval '1 minute')`;
      await sweep();
      expect(storage.objects.has(foreign)).toBe(true);
      expect(await intents(a.tenantId)).toEqual([]);
    });
  });

  // ------------------------------------------------- S2 (d) orphan sweep

  describe('S2 (d): the bucket orphan sweep', () => {
    const old = (key: string) => storage.age(key, 2 * DAY);
    const ownedKey = (tenantId: string) =>
      `conversation-media/${tenantId}/${randomUUID()}.jpg`;
    async function put(key: string) {
      await storage.putPrivate({ key, bytes: JPEG, mimeType: 'image/jpeg' });
    }
    const resetCursor = () =>
      prisma.$executeRaw`UPDATE "conversation_media_orphan_sweep"
        SET "cursor" = NULL, "leaseUntil" = NULL WHERE "id" = 'conversation-media'`;
    const cursorOf = async () =>
      (
        await prisma.$queryRaw<
          Array<{ cursor: string | null }>
        >`SELECT "cursor" FROM "conversation_media_orphan_sweep" WHERE "id" = 'conversation-media'`
      )[0].cursor;

    beforeEach(resetCursor);

    it('deletes old objects no row and no intent own (also under a tenant that is gone); keeps the rest', async () => {
      const b = await bot();
      const owned = await seededMedia(b.tenantId);
      old(owned.key);
      const orphan = ownedKey(b.tenantId);
      await put(orphan);
      old(orphan);
      const gone = ownedKey(randomUUID());
      await put(gone);
      old(gone);
      const young = ownedKey(b.tenantId);
      await put(young);
      const pendingId = randomUUID();
      const pendingKey = `conversation-media/${b.tenantId}/${pendingId}.jpg`;
      await put(pendingKey);
      old(pendingKey);
      await prisma.$executeRaw`
        INSERT INTO "conversation_media_intents" ("id", "tenantId", "storageKey", "reason", "dueAt")
        VALUES (${pendingId}, ${b.tenantId}, ${pendingKey}, 'UPLOAD', now() + interval '1 hour')`;
      const malformed = 'conversation-media/not-a-media-object.txt';
      await put(malformed);
      old(malformed);
      const elsewhere = `receipts/${b.tenantId}/${randomUUID()}.jpg`;
      await put(elsewhere);
      old(elsewhere);

      const result = await retention.sweepOrphans();
      expect(result.passCompleted).toBe(true);
      expect(result.deleted).toBeGreaterThanOrEqual(2);
      expect(storage.objects.has(orphan)).toBe(false);
      expect(storage.objects.has(gone)).toBe(false);
      expect(storage.objects.has(owned.key)).toBe(true);
      expect(storage.objects.has(young)).toBe(true);
      expect(storage.objects.has(pendingKey)).toBe(true);
      // Names this module never writes are skipped, and anything outside the
      // prefix is never even listed.
      expect(storage.objects.has(malformed)).toBe(true);
      expect(storage.objects.has(elsewhere)).toBe(true);
      expect(
        storage.listCalls.every((c) => c.prefix === 'conversation-media/'),
      ).toBe(true);
    });

    it('an object whose row was purged (key cleared) but still exists is an orphan', async () => {
      const b = await bot();
      const key = ownedKey(b.tenantId);
      const id = key.split('/')[2].split('.')[0];
      await put(key);
      old(key);
      await prisma.$executeRaw`
        INSERT INTO "conversation_media"
          ("id", "tenantId", "storageKey", "mimeType", "sizeBytes", "sha256",
           "idempotencyKey", "purgeAfter", "purgedAt")
        VALUES (${id}, ${b.tenantId}, NULL, 'image/jpeg', 1, ${'d'.repeat(64)},
                ${randomUUID()}, now(), now())`;
      await retention.sweepOrphans();
      expect(storage.objects.has(key)).toBe(false);
    });

    it('is bounded and resumable: the position is stored, and a pass wraps around', async () => {
      const b = await bot();
      const keys = [] as string[];
      for (let i = 0; i < 5; i++) {
        const key = ownedKey(b.tenantId);
        await put(key);
        old(key);
        keys.push(key);
      }
      // Only this run's pages count: one page of the real size is bigger than
      // the fixture, so the bound is exercised through `maxPages` and the
      // storage page size of the fake via a tiny wrapper.
      const small = new ConversationRetentionService(
        prisma as unknown as ConstructorParameters<
          typeof ConversationRetentionService
        >[0],
        storage,
        {
          list: (input) => storage.list({ ...input, limit: 2 }),
        },
      );
      const first = await small.sweepOrphans({ maxPages: 1 });
      expect(first.passCompleted).toBe(false);
      expect(first.scanned).toBe(2);
      const position = await cursorOf();
      expect(position).not.toBeNull();
      let guard = 0;
      while ((await cursorOf()) !== null && guard++ < 50) {
        await small.sweepOrphans({ maxPages: 1 });
      }
      for (const key of keys) expect(storage.objects.has(key)).toBe(false);
    });

    it('two sweeps at once never scan the same window (lease)', async () => {
      const b = await bot();
      const key = ownedKey(b.tenantId);
      await put(key);
      old(key);
      const [x, y] = await Promise.all([
        retention.sweepOrphans(),
        retention.sweepOrphans(),
      ]);
      expect(x.deleted + y.deleted).toBe(1);
      expect(storage.removed.filter((k) => k === key)).toHaveLength(1);
    });

    it('a failed delete or a storage outage never throws and is found on the next pass', async () => {
      const b = await bot();
      const key = ownedKey(b.tenantId);
      await put(key);
      old(key);
      storage.failRemoveAll = true;
      const failed = await retention.sweepOrphans();
      expect(failed.failed).toBe(1);
      expect(storage.objects.has(key)).toBe(true);
      storage.failRemoveAll = false;
      storage.failList = true;
      await expect(retention.sweepOrphans()).resolves.toMatchObject({
        deleted: 0,
      });
      storage.failList = false;
      await retention.sweepOrphans();
      expect(storage.objects.has(key)).toBe(false);
    });

    it('does nothing without a listing capability', async () => {
      const bare = new ConversationRetentionService(
        prisma as unknown as ConstructorParameters<
          typeof ConversationRetentionService
        >[0],
        storage,
      );
      const result = await bare.sweepOrphans();
      expect(result).toMatchObject({ scanned: 0, deleted: 0 });
    });
  });

  // ----------------------------------------------------------------- N4

  describe('N4: a file referenced by a later message', () => {
    async function uploaded(b: Bot) {
      const res = await upload(b).expect(201);
      return res.body.mediaId as string;
    }

    it('moves the file purge time to the newest reference', async () => {
      const b = await bot();
      const mediaId = await uploaded(b);
      // The file is 11 months old: due in a month, long before a message sent now.
      await prisma.$executeRaw`UPDATE "conversation_media"
        SET "purgeAfter" = now() + interval '1 month' WHERE "id" = ${mediaId}`;
      await postMessages(b, 'wa:5215500000201', [imageMessage(mediaId)]).expect(
        200,
      );
      const [media] = await mediaRows(b.tenantId);
      const [message] = await prisma.conversationMessage.findMany({
        where: { tenantId: b.tenantId },
      });
      expect(media.purgeAfter.getTime()).toBeGreaterThanOrEqual(
        message.purgeAfter.getTime(),
      );
    });

    it('never moves it earlier (the latest reference wins)', async () => {
      const b = await bot();
      const mediaId = await uploaded(b);
      await prisma.$executeRaw`UPDATE "conversation_media"
        SET "purgeAfter" = now() + interval '20 months' WHERE "id" = ${mediaId}`;
      const before = (await mediaRows(b.tenantId))[0].purgeAfter;
      await postMessages(b, 'wa:5215500000202', [imageMessage(mediaId)]).expect(
        200,
      );
      expect((await mediaRows(b.tenantId))[0].purgeAfter).toEqual(before);
    });

    it('the retention does not purge the file before the later message is due', async () => {
      const b = await bot();
      const mediaId = await uploaded(b);
      await prisma.$executeRaw`UPDATE "conversation_media"
        SET "purgeAfter" = now() + interval '2 seconds' WHERE "id" = ${mediaId}`;
      await postMessages(b, 'wa:5215500000203', [imageMessage(mediaId)]).expect(
        200,
      );
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await sweep();
      const [media] = await mediaRows(b.tenantId);
      expect(media.purgedAt).toBeNull();
      expect(storage.objects.has(media.storageKey as string)).toBe(true);
    });

    it('a file that is already due, or that a purge has claimed, cannot be referenced', async () => {
      const b = await bot();
      const due = await uploaded(b);
      await prisma.$executeRaw`UPDATE "conversation_media"
        SET "purgeAfter" = now() - interval '1 minute' WHERE "id" = ${due}`;
      const res = await postMessages(b, 'wa:5215500000204', [
        imageMessage(due),
      ]).expect(422);
      expect(res.body.code).toBe('MEDIA_NOT_FOUND');
      const claimed = await uploaded(b);
      await prisma.$executeRaw`UPDATE "conversation_media"
        SET "purgeLeaseUntil" = now() + interval '5 minutes' WHERE "id" = ${claimed}`;
      await postMessages(b, 'wa:5215500000204', [imageMessage(claimed)]).expect(
        422,
      );
      expect(
        await prisma.conversationMessage.count({
          where: { tenantId: b.tenantId },
        }),
      ).toBe(0);
    });

    it('the reference locks the file: a purge claim skips it until the batch commits', async () => {
      const b = await bot();
      const mediaId = await uploaded(b);
      await prisma.$executeRaw`UPDATE "conversation_media"
        SET "purgeAfter" = now() + interval '1 second' WHERE "id" = ${mediaId}`;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      // What the ingest transaction does: lock the row FOR UPDATE and hold it.
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "conversation_media" WHERE "id" = ${mediaId} FOR UPDATE`;
        locked();
        await held;
      });
      await ready;
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      // The purge also claims other specs' due rows: look at THIS file only.
      await sweep();
      const [claimed] = await prisma.$queryRaw<
        Array<{ purgeLeaseUntil: Date | null }>
      >`SELECT "purgeLeaseUntil" FROM "conversation_media" WHERE "id" = ${mediaId}`;
      expect(claimed.purgeLeaseUntil).toBeNull();
      release();
      await holder;
      const [after] = await mediaRows(b.tenantId);
      expect(after.purgedAt).toBeNull();
      expect(storage.objects.has(after.storageKey as string)).toBe(true);
    });
  });

  // ----------------------------------------------------------------- N3

  describe('N3: an emptied chat that a request points at keeps its row', () => {
    async function emptiedChat(tenantId: string, withRequest: boolean) {
      const ref = `wa:5215500${Math.floor(Math.random() * 1e6)}`;
      const chat = await prisma.chatbotConversation.create({
        data: { tenantId, conversationRef: ref, nextSeq: 4 },
      });
      await prisma.$executeRaw`UPDATE "chatbot_conversations"
        SET "updatedAt" = now() - interval '3 days' WHERE "id" = ${chat.id}`;
      for (const seq of [1, 2, 3]) {
        await prisma.$executeRaw`
          INSERT INTO "conversation_messages"
            ("id", "tenantId", "conversationId", "seq", "direction", "author", "type", "text",
             "receivedAt", "purgeAfter")
          VALUES (${randomUUID()}, ${tenantId}, ${chat.id}, ${seq}, 'IN', 'CUSTOMER',
                  'TEXT', 'hola', now() - interval '13 months', now() - interval '1 day')`;
      }
      if (withRequest) {
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
      return { id: chat.id, ref };
    }

    it('keeps the chat (and nextSeq) when a request points at it; the next message continues the seq', async () => {
      const b = await bot();
      const { id, ref } = await emptiedChat(b.tenantId, true);
      await sweep();
      expect(
        await prisma.conversationMessage.count({
          where: { conversationId: id },
        }),
      ).toBe(0);
      const kept = await prisma.chatbotConversation.findUnique({
        where: { id },
      });
      expect(kept?.nextSeq).toBe(4);
      const res = await postMessages(b, ref, [
        {
          waMessageId: `wamid.${randomUUID()}`,
          direction: 'IN',
          type: 'TEXT',
          text: 'otra vez',
          providerTimestamp: NOW(),
          observedAt: NOW(),
        },
      ]).expect(200);
      // Never seq 1 again: a client holding `after=3` still sees it.
      expect(res.body.accepted[0].seq).toBe(4);
    });

    it('still deletes an emptied chat no request ever pointed at (nobody can hold a cursor)', async () => {
      const b = await bot();
      const { id } = await emptiedChat(b.tenantId, false);
      await sweep();
      expect(await prisma.chatbotConversation.count({ where: { id } })).toBe(0);
    });
  });
});
