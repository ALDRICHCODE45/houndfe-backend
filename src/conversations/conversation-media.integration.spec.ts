/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON */
/**
 * human-intervention / unit 9 — conversation media against REAL PostgreSQL and
 * a fake private storage (contract §3.6, §6.3, §12.5):
 *   - `POST /chatbot-api/media`: magic-byte allowlist, 10 MB cap, idempotency
 *     by key + sha256 (also under a race), private storage under a tenant
 *     prefix, storage failure is retryable;
 *   - `GET /chatbot-media/:id`: authenticated proxy, permission per request,
 *     tenant isolation, purged = 410, never a public URL, never a key in a log.
 */
import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'crypto';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../test/integration/reset-db';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
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
  ConversationMirrorService,
  CONVERSATION_MIRROR_STORE,
} from './application/conversation-mirror.service';
import { CONVERSATION_MEDIA_MAX_BYTES } from './domain/conversation-media';
import { PrismaConversationMediaStore } from './infrastructure/prisma-conversation-media.store';
import { PrismaConversationMirrorStore } from './infrastructure/prisma-conversation-mirror.store';
import { BotConversationController } from './presentation/bot-conversation.controller';
import { BotMediaController } from './presentation/bot-media.controller';
import { ConversationMediaController } from './presentation/conversation-media.controller';
import { FakeMediaStorage } from './test-support/fake-media-storage';
import { StubGuard, StubPermissionsGuard } from './test-support/staff-stubs';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const ascii = (s: string) => Buffer.from(s, 'latin1');
const pad = (head: Buffer, size = 256) =>
  Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x61)]);
const JPEG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const PNG = pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const WEBP = pad(
  Buffer.concat([
    ascii('RIFF'),
    Buffer.from([0x24, 0, 0, 0]),
    ascii('WEBPVP8 '),
  ]),
);
const PDF = pad(ascii('%PDF-1.7\n'));
const OGG = pad(ascii('OggS'));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PHONE_REF = 'wa:5215512345678';

describeIfDb('conversation media (PostgreSQL, fake storage)', () => {
  const prisma = integrationPrisma();
  const storage = new FakeMediaStorage();
  let app: INestApplication;
  const tenants: string[] = [];
  const credentials: string[] = [];
  let logged: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BotRateLimitModule,
      ],
      controllers: [
        BotMediaController,
        BotConversationController,
        ConversationMediaController,
      ],
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
    storage.failGet = false;
    storage.putDelayMs = 0;
    logged = [];
    const capture = (...args: unknown[]) => {
      logged.push(args.map((a) => JSON.stringify(a) ?? String(a)).join(' '));
    };
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(capture);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    await prisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: credentials } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  });

  async function bot(scopes = ['media:write', 'conversation:write']) {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Medios', slug: `cv-media-${id}` },
    });
    const token = `svc_${randomUUID()}`;
    const credential = await prisma.serviceCredential.create({
      data: {
        tenantId: id,
        name: 'bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes,
        rateLimit: 60,
      },
    });
    credentials.push(credential.id);
    return { tenantId: id, token };
  }
  type Bot = Awaited<ReturnType<typeof bot>>;

  const upload = (
    b: Bot,
    file: Buffer | null,
    opts: {
      key?: string | null;
      sha256?: string;
      filename?: string;
      contentType?: string;
      extraField?: boolean;
    } = {},
  ) => {
    let req = request(app.getHttpServer())
      .post('/chatbot-api/media')
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Branch-Id', b.tenantId);
    const key = opts.key === undefined ? randomUUID() : opts.key;
    if (key !== null) req = req.set('X-Idempotency-Key', key);
    if (opts.sha256) req = req.field('sha256', opts.sha256);
    if (opts.extraField) req = req.field('tenantId', 'x');
    if (file) {
      req = req.attach('file', file, {
        filename: opts.filename ?? 'file.bin',
        contentType: opts.contentType ?? 'application/octet-stream',
      });
    }
    return req;
  };

  const staff = (path: string, role: string, tenantId: string) =>
    request(app.getHttpServer()).get(path).set({
      'x-test-role': role,
      'x-test-tenant': tenantId,
      'x-test-user': randomUUID(),
    });

  const rowsOf = (tenantId: string) =>
    prisma.conversationMedia.findMany({ where: { tenantId } });

  // ------------------------------------------------------------- upload

  describe('POST /chatbot-api/media', () => {
    it.each([
      ['jpeg', JPEG, 'image/jpeg'],
      ['png', PNG, 'image/png'],
      ['webp (also stickers)', WEBP, 'image/webp'],
      ['pdf', PDF, 'application/pdf'],
      ['ogg voice note', OGG, 'audio/ogg'],
    ])(
      'stores a %s privately and answers the media id',
      async (_n, bytes, mime) => {
        const b = await bot();
        const res = await upload(b, bytes).expect(201);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toEqual({
          mediaId: expect.any(String),
          mimeType: mime,
          sizeBytes: bytes.length,
          sha256: sha(bytes),
        });
        const [row] = await rowsOf(b.tenantId);
        expect(row.id).toBe(res.body.mediaId);
        // Private object under the tenant's prefix; the key is never answered.
        expect(row.storageKey).toMatch(
          new RegExp(
            `^conversation-media/${b.tenantId}/${row.id}\\.[a-z0-9]+$`,
          ),
        );
        expect(storage.objects.get(row.storageKey as string)?.mimeType).toBe(
          mime,
        );
        expect(JSON.stringify(res.body)).not.toContain('conversation-media');
        // Retained 12 months from upload.
        const months =
          (row.purgeAfter.getUTCFullYear() - row.createdAt.getUTCFullYear()) *
            12 +
          row.purgeAfter.getUTCMonth() -
          row.createdAt.getUTCMonth();
        expect(months).toBe(12);
      },
    );

    it('decides the type by the bytes, ignoring the declared type and file name', async () => {
      const b = await bot();
      const res = await upload(b, PDF, {
        filename: 'cat.jpg',
        contentType: 'image/jpeg',
      }).expect(201);
      expect(res.body.mimeType).toBe('application/pdf');
    });

    it.each([
      [
        'html declared as an image',
        pad(ascii('<html><script>alert(1)</script>')),
        'image/jpeg',
      ],
      [
        'svg',
        pad(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')),
        'image/svg+xml',
      ],
      ['an executable', pad(ascii('MZ')), 'application/octet-stream'],
      [
        'a video (mp4 isom)',
        pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), ascii('ftypisom')])),
        'video/mp4',
      ],
      ['a zip', pad(ascii('PK\x03\x04')), 'application/zip'],
    ])(
      '415 MEDIA_TYPE_NOT_ALLOWED for %s; nothing stored',
      async (_n, bytes, contentType) => {
        const b = await bot();
        const res = await upload(b, bytes, { contentType }).expect(415);
        expect(res.body.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
        expect(await rowsOf(b.tenantId)).toEqual([]);
        expect(storage.objects.size).toBe(0);
      },
    );

    it('accepts exactly 10 MB and refuses one byte more with 413 MEDIA_TOO_LARGE', async () => {
      const b = await bot();
      const exact = Buffer.concat([
        JPEG,
        Buffer.alloc(CONVERSATION_MEDIA_MAX_BYTES - JPEG.length, 1),
      ]);
      await upload(b, exact).expect(201);
      const over = Buffer.concat([exact, Buffer.from([1])]);
      const res = await upload(b, over).expect(413);
      expect(res.body.code).toBe('MEDIA_TOO_LARGE');
      expect(await rowsOf(b.tenantId)).toHaveLength(1);
    }, 60_000);

    it('replays the same key and bytes with the same media id and one object', async () => {
      const b = await bot();
      const key = randomUUID();
      const first = await upload(b, JPEG, { key }).expect(201);
      const again = await upload(b, JPEG, { key, sha256: sha(JPEG) }).expect(
        200,
      );
      expect(again.body.mediaId).toBe(first.body.mediaId);
      expect(await rowsOf(b.tenantId)).toHaveLength(1);
      expect(storage.objects.size).toBe(1);
    });

    it('409 IDEMPOTENCY_CONFLICT when the key comes back with other bytes', async () => {
      const b = await bot();
      const key = randomUUID();
      await upload(b, JPEG, { key }).expect(201);
      const res = await upload(b, PNG, { key }).expect(409);
      expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(storage.objects.size).toBe(1);
    });

    it('two simultaneous uploads with one key store one row and leave one object', async () => {
      const b = await bot();
      storage.putDelayMs = 60;
      const key = randomUUID();
      const [x, y] = await Promise.all([
        upload(b, JPEG, { key }),
        upload(b, JPEG, { key }),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 201]);
      expect(x.body.mediaId).toBe(y.body.mediaId);
      expect(await rowsOf(b.tenantId)).toHaveLength(1);
      expect(storage.objects.size).toBe(1);
    });

    it('keys are per tenant', async () => {
      const a = await bot();
      const b = await bot();
      const key = randomUUID();
      const first = await upload(a, JPEG, { key }).expect(201);
      const second = await upload(b, JPEG, { key }).expect(201);
      expect(second.body.mediaId).not.toBe(first.body.mediaId);
    });

    it.each([
      ['no key', { key: null }],
      ['a key that is not a lowercase uuid', { key: 'abc' }],
      ['an uppercase uuid', { key: randomUUID().toUpperCase() }],
      ['a wrong sha256', { sha256: 'f'.repeat(64) }],
      ['a malformed sha256', { sha256: 'xyz' }],
      ['an unknown field', { extraField: true }],
    ])('400 VALIDATION_ERROR for %s', async (_n, opts) => {
      const b = await bot();
      const res = await upload(b, JPEG, opts).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(storage.objects.size).toBe(0);
    });

    it('400 for no file and for an empty file', async () => {
      const b = await bot();
      await upload(b, null).expect(400);
      await upload(b, Buffer.alloc(0)).expect(400);
    });

    it('503 MEDIA_STORAGE_FAILED leaves no row, and the same key succeeds later', async () => {
      const b = await bot();
      const key = randomUUID();
      storage.failPut = true;
      const res = await upload(b, JPEG, { key }).expect(503);
      expect(res.body.code).toBe('MEDIA_STORAGE_FAILED');
      expect(await rowsOf(b.tenantId)).toEqual([]);
      storage.failPut = false;
      await upload(b, JPEG, { key }).expect(201);
    });

    it('401 without a credential, 403 INSUFFICIENT_SCOPE without media:write', async () => {
      const b = await bot(['conversation:write']);
      await request(app.getHttpServer()).post('/chatbot-api/media').expect(401);
      const res = await upload(b, JPEG).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
      expect(storage.objects.size).toBe(0);
    });

    it('feeds the mirror: the media id can be used in a mirrored message, and a purged file cannot', async () => {
      const b = await bot();
      const up = await upload(b, JPEG).expect(201);
      const message = {
        waMessageId: `wamid.${randomUUID()}`,
        direction: 'IN',
        type: 'IMAGE',
        mediaId: up.body.mediaId,
        providerTimestamp: new Date().toISOString(),
        observedAt: new Date().toISOString(),
      };
      await request(app.getHttpServer())
        .post(
          `/chatbot-api/conversations/${encodeURIComponent(PHONE_REF)}/messages:batch`,
        )
        .set('Authorization', `Bearer ${b.token}`)
        .send({ messages: [message] })
        .expect(200);
      await prisma.conversationMedia.update({
        where: { id: up.body.mediaId },
        data: { purgedAt: new Date(), storageKey: null },
      });
      const res = await request(app.getHttpServer())
        .post(
          `/chatbot-api/conversations/${encodeURIComponent(PHONE_REF)}/messages:batch`,
        )
        .set('Authorization', `Bearer ${b.token}`)
        .send({
          messages: [{ ...message, waMessageId: `wamid.${randomUUID()}` }],
        })
        .expect(422);
      expect(res.body.code).toBe('MEDIA_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------- proxy

  describe('GET /chatbot-media/:id', () => {
    async function stored(bytes = JPEG) {
      const b = await bot();
      const up = await upload(b, bytes).expect(201);
      return { b, id: up.body.mediaId as string };
    }
    const path = (id: string, query = '') => `/chatbot-media/${id}${query}`;

    it('streams the original with the real type and no-store, inline, nosniff', async () => {
      const { b, id } = await stored(PNG);
      const res = await staff(path(id), 'manager', b.tenantId)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain('sandbox');
      expect(res.headers['content-disposition']).toMatch(/^inline/);
      expect(res.headers['location']).toBeUndefined();
      expect((res.body as Buffer).equals(PNG)).toBe(true);
    });

    it('serves a PDF inline with a generic file name', async () => {
      const { b, id } = await stored(PDF);
      const res = await staff(path(id), 'manager', b.tenantId).expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(
        'inline; filename="documento.pdf"',
      );
    });

    it('needs read:ChatbotConversation on every request', async () => {
      const { b, id } = await stored();
      await staff(path(id), 'cashier', b.tenantId).expect(200);
      await staff(path(id), 'conversationOnly', b.tenantId).expect(403);
      await staff(path(id), 'readOnly', b.tenantId).expect(403);
      await staff(path(id), 'updateOnly', b.tenantId).expect(403);
    });

    it('is tenant isolated: another tenant gets the 404 of an unknown id', async () => {
      const { id } = await stored();
      const other = await bot();
      const foreign = await staff(path(id), 'manager', other.tenantId).expect(
        404,
      );
      const unknown = await staff(
        path(randomUUID()),
        'manager',
        other.tenantId,
      ).expect(404);
      expect(foreign.body).toEqual(unknown.body);
      await staff(path('nope'), 'manager', other.tenantId).expect(400);
    });

    it('410 MEDIA_PURGED once the retention removed the file', async () => {
      const { b, id } = await stored();
      await prisma.conversationMedia.update({
        where: { id },
        data: { purgedAt: new Date(), storageKey: null },
      });
      const res = await staff(path(id), 'manager', b.tenantId).expect(410);
      expect(res.body.code).toBe('MEDIA_PURGED');
    });

    it('?variant=thumb is 404 THUMB_UNAVAILABLE (no thumbnails yet); any other variant is 400', async () => {
      const { b, id } = await stored();
      const thumb = await staff(
        path(id, '?variant=thumb'),
        'manager',
        b.tenantId,
      ).expect(404);
      expect(thumb.body.code).toBe('THUMB_UNAVAILABLE');
      await staff(path(id, '?variant=huge'), 'manager', b.tenantId).expect(400);
      await staff(path(id, '?variant=original'), 'manager', b.tenantId).expect(
        200,
      );
    });

    it('503 when storage fails, 404 when the object is gone; the key is never logged', async () => {
      const { b, id } = await stored();
      storage.failGet = true;
      const down = await staff(path(id), 'manager', b.tenantId).expect(503);
      expect(down.body.code).toBe('MEDIA_STORAGE_FAILED');
      storage.failGet = false;
      storage.objects.clear();
      await staff(path(id), 'manager', b.tenantId).expect(404);
      const [row] = await rowsOf(b.tenantId);
      expect(logged.join('\n')).not.toContain('conversation-media');
      expect(logged.join('\n')).not.toContain(row.id.concat('.jpg'));
    });

    it('never logs a storage key on upload failure either', async () => {
      const b = await bot();
      storage.failPut = true;
      await upload(b, JPEG).expect(503);
      expect(logged.join('\n')).not.toContain('conversation-media');
    });
  });
});

// The shared client keeps a pool open for the whole run unless it is closed:
// the integration suite runs every spec in one process against one database.
afterAll(async () => {
  await integrationPrisma().$disconnect();
});
