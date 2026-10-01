/**
 * HD-EXP-JOURNEY — one intake-born EXPIRATION decision carried end to end over
 * REAL HTTP + REAL PostgreSQL for BOTH reviewer actions. Contract:
 * `houndfe-chatbot-human-decisions/docs/human-decisions-expiration-v1.md`.
 *
 * Real chain: both scoped sanitizing body parsers, the real filters and global
 * `ValidationPipe`, the real service/JWT/tenant/active-reviewer/permissions
 * guards with committed RBAC, real nestjs-cls ALS, and the real Prisma
 * intake/read/resolve/poll/ACK adapters. Only substitutions: the in-memory
 * credential harness and a test-only `ConfigService` secret. `AppModule` is not
 * booted (Inngest/mail/provider side effects). No `HumanDecision` row is
 * seeded: it originates from intake (catalog + RBAC only).
 *
 * ISOLATED-DB GUARD: both `.env.test` and the ACTIVE `process.env.DATABASE_URL`
 * must be the exact isolated target before any reset; the shared guard helper
 * owns the proof, the skip decision and the redacted errors.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import { createIsolatedDatabaseGuard } from '../../../test/integration/setup/assert-isolated-human-decisions-database';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../../auth/infrastructure/strategies/jwt.strategy';
import { ServiceCredential } from '../../chatbot-api/domain/service-credential.entity';
import {
  IServiceCredentialRepository,
  SERVICE_CREDENTIAL_REPOSITORY,
} from '../../chatbot-api/domain/service-credential.repository';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { createListingValidationExceptionFactory } from '../../shared/listing/listing-validation-exception.factory';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import {
  hashBotApplicationOutcomeEvidence,
  PROVIDER_ACCEPTED,
} from '../domain/bot-application-outcome.request';
import { BOT_APPLICATION_OUTCOME_REPOSITORY } from '../domain/bot-application-outcome.repository';
import { BOT_RESTOCK_POLL_REPOSITORY } from '../domain/bot-restock-poll.repository';
import { EXPIRATION_TYPE } from '../domain/expiration-intake.request';
import { EXPIRATION_INTAKE_REPOSITORY } from '../domain/expiration-intake.repository';
import { HUMAN_DECISION_REVIEW_READ_REPOSITORY } from '../domain/human-decision-review-read.repository';
import { HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY } from '../domain/human-decision-review-resolve.repository';
import { RESTOCK_INTAKE_REPOSITORY } from '../domain/restock-intake.repository';
import { PrismaBotApplicationOutcomeRepository } from '../infrastructure/prisma-bot-application-outcome.repository';
import { PrismaBotRestockPollRepository } from '../infrastructure/prisma-bot-restock-poll.repository';
import { PrismaExpirationIntakeRepository } from '../infrastructure/prisma-expiration-intake.repository';
import { PrismaHumanDecisionReviewReadRepository } from '../infrastructure/prisma-human-decision-review-read.repository';
import { PrismaHumanDecisionReviewResolveRepository } from '../infrastructure/prisma-human-decision-review-resolve.repository';
import { PrismaRestockIntakeRepository } from '../infrastructure/prisma-restock-intake.repository';
import { BotApplicationOutcomeController } from './bot-application-outcome.controller';
import { BotRestockIntakeController } from './bot-restock-intake.controller';
import { BotRestockPollController } from './bot-restock-poll.controller';
import {
  installBotApplicationOutcomeBodyParser,
  installHumanDecisionBodyParser,
} from './filters/human-decision-body-parser';
import { HumanDecisionHttpFilter } from './filters/human-decision-http.filter';
import { HumanDecisionActiveReviewerGuard } from './guards/human-decision-active-reviewer.guard';
import { HumanDecisionReviewController } from './human-decision-review.controller';

const INTAKE_URL = '/chatbot-api/human-decisions';
const LIST_URL = '/human-decisions';

const isolatedDbGuard = createIsolatedDatabaseGuard({
  reset: resetAndSeedBaseline,
});

const describeIfDb = isolatedDbGuard.skip ? describe.skip : describe;

if (!isolatedDbGuard.skip) {
  // Fail fast at module load, before any fixture or reset touches the DB.
  isolatedDbGuard.assertTarget();
}

type Json = Record<string, unknown>;

const TEST_SECRET = 'hd-exp-journey-test-secret-not-a-production-key';
const BOT_TOKEN = 'svc_exp_journey';
const POSITIVE_ACTION = 'PROVIDE_EXPIRATION_TEXT';
const NEGATIVE_ACTION = 'REPORT_EXPIRATION_UNAVAILABLE';
const TITLE = 'Consulta de vencimiento';
const SUMMARY =
  'El chatbot solicitó información de vencimiento de un producto.';
/** Decomposed + padded text: only NFC/collapse/trim can produce the match. */
const RAW_TEXT = '  Vence   el Cafe\u0301  2027-01  ';
const TEXT = 'Vence el Café 2027-01';
const PRODUCT_NAME = 'Ibuprofeno 400 mg';
const TENANT_NAME = 'Journey Tenant';
const MANAGER_NAME = 'Journey Manager';
const ATTEMPT_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const RESOLUTION_REQUEST_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PROVIDER_MESSAGE_ID = 'wamid.HBgLNTQ5MTEwMDAwMDAw';

const jwtService = new JwtService({
  secret: TEST_SECRET,
  signOptions: { expiresIn: '1h' },
});

async function seedTenant(): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().tenant.create({
    data: { id, name: TENANT_NAME, slug: `journey-${id}` },
  });
  return id;
}

async function seedCatalogProduct(tenantId: string): Promise<string> {
  const id = crypto.randomUUID();
  await integrationPrisma().product.create({
    data: {
      id,
      tenantId,
      name: PRODUCT_NAME,
      unit: 'CAJA',
      hasVariants: false,
      includeInOnlineCatalog: true,
    },
  });
  return id;
}

/** Registry permission survives the tenant truncate; upsert keeps it idempotent. */
async function seedPermission(action: string): Promise<string> {
  const permission = await integrationPrisma().permission.upsert({
    where: { subject_action: { subject: 'HumanDecision', action } },
    update: {},
    create: { subject: 'HumanDecision', action, description: action },
  });
  return permission.id;
}

async function seedRbacWorld(tenantId: string) {
  const [readId, updateId] = await Promise.all([
    seedPermission('read'),
    seedPermission('update'),
  ]);
  const role = await integrationPrisma().role.create({
    data: { tenantId, name: 'Manager' },
  });
  await integrationPrisma().rolePermission.createMany({
    data: [
      { roleId: role.id, permissionId: readId },
      { roleId: role.id, permissionId: updateId },
    ],
  });
  const managerId = crypto.randomUUID();
  const email = `journey-${managerId}@example.test`;
  await integrationPrisma().user.create({
    data: {
      id: managerId,
      email,
      name: MANAGER_NAME,
      hashedPassword: 'not-a-real-hash',
      isActive: true,
    },
  });
  await integrationPrisma().tenantMembership.create({
    data: { userId: managerId, tenantId, roleId: role.id },
  });
  return {
    managerId,
    token: jwtService.sign({
      sub: managerId,
      email,
      tenantId,
      tenantSlug: 'journey',
      isSuperAdmin: false,
    }),
  };
}

/** Established in-memory credential harness; credentials are never persisted. */
const credentialsByHash = new Map<string, ServiceCredential>();

const credentialRepository: IServiceCredentialRepository = {
  findByHashedKey: (hashedKey) =>
    Promise.resolve(credentialsByHash.get(hashedKey) ?? null),
  touchLastUsedAt: () => Promise.resolve(),
};

function registerCredential(tenantId: string): void {
  const credential = ServiceCredential.fromPersistence({
    id: `cred-${crypto.randomUUID()}`,
    tenantId,
    name: 'EXPIRATION journey bot',
    hashedKey: createHash('sha256').update(BOT_TOKEN).digest('hex'),
    scopes: [
      'human-decisions:create',
      'human-decisions:read',
      'human-decisions:ack',
    ],
    isActive: true,
    lastUsedAt: null,
    rateLimit: 1000,
    createdAt: new Date(),
    revokedAt: null,
  });
  credentialsByHash.set(credential.hashedKey, credential);
}

/** Real Prisma adapter bindings; no port is mocked in this journey. */
const REPOSITORY_BINDINGS = [
  [RESTOCK_INTAKE_REPOSITORY, PrismaRestockIntakeRepository],
  [EXPIRATION_INTAKE_REPOSITORY, PrismaExpirationIntakeRepository],
  [BOT_RESTOCK_POLL_REPOSITORY, PrismaBotRestockPollRepository],
  [BOT_APPLICATION_OUTCOME_REPOSITORY, PrismaBotApplicationOutcomeRepository],
  [
    HUMAN_DECISION_REVIEW_READ_REPOSITORY,
    PrismaHumanDecisionReviewReadRepository,
  ],
  [
    HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY,
    PrismaHumanDecisionReviewResolveRepository,
  ],
] as const;

/** [action, expected normalized text, raw operator text] per journey variant. */
const ACTION_CASES: Array<[string, string | null, string | null]> = [
  [POSITIVE_ACTION, TEXT, RAW_TEXT],
  [NEGATIVE_ACTION, null, null],
];

/** Reviewer resolve body; `expirationText` is omitted for the negative action. */
function resolveBody(action: string, rawText: string | null): Json {
  return {
    action,
    ...(rawText === null ? {} : { expirationText: rawText }),
    expectedVersion: 1,
    resolutionRequestId: RESOLUTION_REQUEST_ID,
  };
}

describeIfDb('EXPIRATION same-decision journey HTTP + PostgreSQL', () => {
  let app: INestApplication;

  const http = () => request(app.getHttpServer() as import('node:http').Server);
  const getBot = (url: string, token: string) =>
    http().get(url).set('Authorization', `Bearer ${token}`);
  const postBot = (url: string, token: string) =>
    http().post(url).set('Authorization', `Bearer ${token}`);
  const readRow = (id: string) =>
    integrationPrisma().humanDecision.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await isolatedDbGuard.resetBaseline();

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
      ],
      controllers: [
        BotRestockIntakeController,
        HumanDecisionReviewController,
        BotRestockPollController,
        BotApplicationOutcomeController,
      ],
      providers: [
        HumanDecisionHttpFilter,
        ServiceAuthGuard,
        JwtStrategy,
        JwtAuthGuard,
        TenantContextGuard,
        PermissionsGuard,
        CaslAbilityFactory,
        HumanDecisionActiveReviewerGuard,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn(() => TEST_SECRET),
            get: jest.fn(() => TEST_SECRET),
          },
        },
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useValue: credentialRepository,
        },
        ...REPOSITORY_BINDINGS.map(([provide, useClass]) => ({
          provide,
          useClass,
        })),
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirror `main.ts`: global pipes/filters, CORS first, then BOTH scoped
    // sanitizing body parsers, all BEFORE init.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: createListingValidationExceptionFactory(),
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new PrismaExceptionFilter(),
    );
    app.enableCors({ origin: 'https://sistem.houndfe.com', credentials: true });
    installHumanDecisionBodyParser(app);
    installBotApplicationOutcomeBodyParser(app);

    await app.init();
  });

  afterEach(async () => {
    credentialsByHash.clear();
    await isolatedDbGuard.resetBaseline();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await disconnectIntegrationPrisma();
  });

  it.each(ACTION_CASES)(
    'carries ONE intake-born decision through POS, poll and ACK: %s',
    async (action, text, rawText) => {
      const tenantId = await seedTenant();
      registerCredential(tenantId);
      const productId = await seedCatalogProduct(tenantId);
      const { managerId, token } = await seedRbacWorld(tenantId);
      const snapshot = {
        branchId: tenantId,
        branchName: TENANT_NAME,
        productId,
        productName: PRODUCT_NAME,
        unit: 'CAJA',
        variantId: null,
        variantName: null,
        variantOption: null,
        variantValue: null,
      };

      const sourceRequestId = crypto.randomUUID();
      const receipt = (
        await postBot(INTAKE_URL, BOT_TOKEN)
          .set('X-Idempotency-Key', sourceRequestId)
          .send({
            sourceRequestId,
            type: EXPIRATION_TYPE,
            productId,
            variantId: null,
          })
          .expect(201)
      ).body as Json;
      const id = receipt.id as string;
      // `toEqual` pins the EXACT receipt key set and the immutable snapshot.
      expect(receipt).toEqual({
        id,
        sourceRequestId,
        type: EXPIRATION_TYPE,
        status: 'PENDING',
        version: 1,
        createdAt: receipt.createdAt,
        snapshot,
        supersedesDecisionId: null,
        resolution: null,
        applyBefore: null,
      });

      const listBody = (
        await getBot(`${LIST_URL}?status=PENDING`, token).expect(200)
      ).body as Json;
      expect(listBody.pagination).toEqual({
        pageIndex: 0,
        pageSize: 20,
        totalCount: 1,
        pageCount: 1,
      });
      const pendingItem = (listBody.data as Json[])[0];
      expect(pendingItem).toEqual({
        id,
        type: EXPIRATION_TYPE,
        title: TITLE,
        sanitizedSummary: SUMMARY,
        createdAt: receipt.createdAt,
        snapshot,
        status: 'PENDING',
        version: 1,
        resolution: null,
        allowedActions: [POSITIVE_ACTION, NEGATIVE_ACTION],
      });

      // `toEqual` pins the POS key set, so no authority column can ride along.
      const detail = await getBot(`${LIST_URL}/${id}`, token).expect(200);
      expect(detail.body).toEqual(pendingItem);

      const resolved = (
        await postBot(`${LIST_URL}/${id}/resolve`, token)
          .send(resolveBody(action, rawText))
          .expect(200)
      ).body as Json;
      const afterResolve = await readRow(id);
      const resolvedAt = (afterResolve.resolvedAt as Date).toISOString();
      expect(resolved).toEqual({
        id,
        type: EXPIRATION_TYPE,
        title: TITLE,
        sanitizedSummary: SUMMARY,
        createdAt: receipt.createdAt,
        snapshot,
        status: 'RESOLVED',
        version: 2,
        resolution: {
          action,
          ...(text === null ? {} : { expirationText: text }),
          resolvedAt,
          resolvedBy: { id: managerId, displayName: MANAGER_NAME },
        },
        allowedActions: [],
      });
      expect(afterResolve).toMatchObject({
        status: 'RESOLVED',
        version: 2,
        resolutionAction: action,
        expirationText: text,
        resolvedById: managerId,
        resolvedByActorId: managerId,
        resolvedByDisplayName: MANAGER_NAME,
      });
      if (text !== null) {
        // NFC + collapsed: the raw operator text is never echoed.
        expect(JSON.stringify(resolved)).not.toContain(RAW_TEXT);
      }

      const expectedPoll: Json = {
        id,
        sourceRequestId,
        type: EXPIRATION_TYPE,
        status: 'RESOLVED',
        version: 2,
        createdAt: receipt.createdAt,
        snapshot,
        supersedesDecisionId: null,
        resolution: {
          action,
          ...(text === null ? {} : { expirationText: text }),
          resolvedAt,
        },
        applyBefore: new Date(
          (afterResolve.resolvedAt as Date).getTime() + 86_400_000,
        ).toISOString(),
      };
      const poll = await getBot(`${INTAKE_URL}/${id}`, BOT_TOKEN).expect(200);
      expect(poll.headers['cache-control']).toBe('no-store');
      // Exact keys exclude authority fields; branchId is intentionally public.
      expect(poll.body).toEqual(expectedPoll);
      const pollSerialized = JSON.stringify(poll.body);
      expect(pollSerialized).not.toContain(managerId);
      expect(pollSerialized).not.toContain(MANAGER_NAME);
      expect(poll.body).not.toHaveProperty('tenantId');

      const attemptMs = (afterResolve.resolvedAt as Date).getTime();
      const attemptedAt = new Date(attemptMs + 60_000).toISOString();
      const observedAt = new Date(attemptMs + 64_500).toISOString();
      const ackBody: Json = {
        attemptId: ATTEMPT_ID,
        attemptedAt,
        expectedResolutionVersion: 2,
        outcome: PROVIDER_ACCEPTED,
        providerMessageId: PROVIDER_MESSAGE_ID,
        providerAcceptedObservedAt: observedAt,
      };
      const ack = await postBot(
        `${INTAKE_URL}/${id}/application-outcome`,
        BOT_TOKEN,
      )
        .send(ackBody)
        .expect(200);
      expect(ack.body).toEqual({
        id,
        version: 2,
        attemptId: ATTEMPT_ID,
        outcome: PROVIDER_ACCEPTED,
        ackReceivedAt: (ack.body as Json).ackReceivedAt,
      });
      expect(ack.headers['cache-control']).toBe('no-store');
      const ackReceivedAt = (ack.body as Json).ackReceivedAt;

      const ackRow = await readRow(id);
      expect(ackRow.id).toBe(id);
      expect(ackRow).toMatchObject({
        status: 'RESOLVED',
        version: 2,
        resolutionAction: action,
        resolvedAt: afterResolve.resolvedAt,
        resolvedByActorId: managerId,
        applicationOutcome: PROVIDER_ACCEPTED,
        applicationAttemptId: ATTEMPT_ID,
        applicationEvidenceHash: hashBotApplicationOutcomeEvidence(ackBody),
        applicationEvidenceCode: null,
        providerMessageId: PROVIDER_MESSAGE_ID,
      });
      expect(ackRow.applicationAttemptedAt?.toISOString()).toBe(attemptedAt);
      expect(ackRow.providerAcceptedObservedAt?.toISOString()).toBe(observedAt);
      expect(ackRow.ackReceivedAt?.toISOString()).toBe(ackReceivedAt);
      expect(
        await integrationPrisma().humanDecision.count({ where: { tenantId } }),
      ).toBe(1);

      const terminalPoll = await getBot(
        `${INTAKE_URL}/${id}`,
        BOT_TOKEN,
      ).expect(200);
      expect(terminalPoll.headers['cache-control']).toBe('no-store');
      expect(terminalPoll.body).toEqual(expectedPoll);
      expect(terminalPoll.body).not.toHaveProperty('applicationOutcome');
      expect(terminalPoll.body).not.toHaveProperty('ackReceivedAt');

      const replay = await postBot(
        `${INTAKE_URL}/${id}/application-outcome`,
        BOT_TOKEN,
      )
        .send(ackBody)
        .expect(200);
      expect(replay.body).toEqual(ack.body);
      const replayRow = await readRow(id);
      expect(replayRow.updatedAt.toISOString()).toBe(
        ackRow.updatedAt.toISOString(),
      );
      expect(replayRow.ackReceivedAt?.toISOString()).toBe(ackReceivedAt);
      expect(
        await integrationPrisma().humanDecision.count({ where: { tenantId } }),
      ).toBe(1);
    },
  );
});
