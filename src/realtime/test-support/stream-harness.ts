/**
 * Test harness of the realtime stream (excluded from the build): a Nest app on
 * a real socket with the REAL guards (`ActiveUserGuard`, `PermissionsGuard`,
 * `TenantContextGuard`), hub, store, shaper, access re-check, LISTEN
 * connection, inbox reads and command services against PostgreSQL. Only
 * `JwtAuthGuard` is replaced (it reads the caller from headers): signature
 * checks have their own specs. Used by the integration and perf specs.
 */
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { ClsModule, ClsService } from 'nestjs-cls';
import { integrationPrisma } from '../../../test/integration/reset-db';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { NotificationsService } from '../../notifications/application/notifications.service';
import { NOTIFICATION_READ_EVENTS } from '../../notifications/domain/notification-events.port';
import { RealtimeNotificationEvents } from '../../notifications/infrastructure/realtime-notification-events';
import {
  CHATBOT_REQUEST_COMMAND_STORE,
  CHATBOT_REQUEST_RESOLVER,
  ChatbotRequestCommandsService,
  type StaffCommand,
} from '../../chatbot-requests/application/chatbot-request-commands.service';
import {
  CHATBOT_REQUEST_READ_STORE,
  ChatbotRequestReadsService,
  CUSTOMER_KEY_SEALER,
  INBOX_CLOCK,
  SLA_PAUSE_READER,
} from '../../chatbot-requests/application/chatbot-request-reads.service';
import { CustomerKeySealer } from '../../chatbot-requests/domain/customer-key-sealer';
import {
  allocateFolio,
  refreshCustomerGroup,
} from '../../chatbot-requests/infrastructure/chatbot-request-writes';
import { PrismaChatbotRequestCommandStore } from '../../chatbot-requests/infrastructure/prisma-chatbot-request-command.store';
import { PrismaChatbotRequestReadStore } from '../../chatbot-requests/infrastructure/prisma-chatbot-request-read.store';
import { PrismaSlaPauseReader } from '../../chatbot-requests/infrastructure/prisma-sla-pause.reader';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { PgNotificationListener } from '../../shared/realtime/pg-notification-listener';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import { PrismaConversationReadStore } from '../../conversations/infrastructure/prisma-conversation-read.store';
import { REALTIME_CONVERSATION_READER } from '../application/conversation-event-reader';
import { REALTIME_NOTIFICATION_READER } from '../application/notification-event-reader';
import { AccessGate, REALTIME_ACCESS } from '../application/realtime-access';
import { RealtimeEventShaper } from '../application/realtime-event-shaper';
import {
  REALTIME_HUB_OPTIONS,
  REALTIME_LISTENER,
  REALTIME_SHAPER,
  REALTIME_STORE,
  RealtimeHub,
} from '../application/realtime-hub.service';
import { PrismaConversationEventReader } from '../infrastructure/prisma-conversation-event.reader';
import { PrismaNotificationEventReader } from '../infrastructure/prisma-notification-event.reader';
import { PrismaRealtimeAccess } from '../infrastructure/prisma-realtime-access';
import { PrismaRealtimeEventStore } from '../infrastructure/prisma-realtime-event.store';
import { RealtimeController } from '../presentation/realtime.controller';

export const SECRET = 'integration-secret-of-some-length';

/** The caller comes from headers; everything after it is the real guard chain. */
@Injectable()
class HeaderAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
    }>();
    const userId = req.headers['x-test-user'];
    const tenantId = req.headers['x-test-tenant'];
    if (!userId) throw new UnauthorizedException();
    req.user = {
      userId,
      email: `${userId}@test`,
      tenantId: tenantId ?? null,
      tenantSlug: null,
      isSuperAdmin: false,
    };
    return true;
  }
}

export type Grant = [subject: string, action: string];

export const READ_UPDATE: Grant[] = [
  ['ChatbotRequest', 'read'],
  ['ChatbotRequest', 'update'],
];
export const MANAGER: Grant[] = [
  ...READ_UPDATE,
  ['ChatbotRequestAssignment', 'update'],
  ['CustomerPhone', 'read'],
];
export const CASHIER: Grant[] = READ_UPDATE;

/** An unsigned JWT-shaped string: only the controller reads its `exp`. */
export const fakeJwt = (expSeconds: number): string =>
  `Bearer e30.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.sig`;

export interface HarnessOptions {
  /** Access cache window of the hub (0 = check on every delivery). */
  accessCacheMs?: number;
  hubLimits?: Record<string, number>;
}

export async function createStreamHarness(options: HarnessOptions = {}) {
  const prisma = integrationPrisma();
  const sealer = new CustomerKeySealer(SECRET);
  const moduleRef = await Test.createTestingModule({
    imports: [
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      DatabaseModule,
    ],
    controllers: [RealtimeController],
    providers: [
      ActiveUserGuard,
      PermissionsGuard,
      CaslAbilityFactory,
      TenantRunnerService,
      PgNotificationListener,
      PrismaRealtimeEventStore,
      PrismaRealtimeAccess,
      PrismaNotificationEventReader,
      PrismaConversationReadStore,
      PrismaConversationEventReader,
      RealtimeEventShaper,
      RealtimeHub,
      NotificationsService,
      RealtimeNotificationEvents,
      ChatbotRequestReadsService,
      ChatbotRequestCommandsService,
      {
        provide: NOTIFICATION_READ_EVENTS,
        useExisting: RealtimeNotificationEvents,
      },
      {
        provide: REALTIME_NOTIFICATION_READER,
        useExisting: PrismaNotificationEventReader,
      },
      {
        provide: REALTIME_CONVERSATION_READER,
        useExisting: PrismaConversationEventReader,
      },
      { provide: REALTIME_LISTENER, useExisting: PgNotificationListener },
      { provide: REALTIME_STORE, useExisting: PrismaRealtimeEventStore },
      { provide: REALTIME_SHAPER, useExisting: RealtimeEventShaper },
      {
        provide: REALTIME_ACCESS,
        inject: [PrismaRealtimeAccess],
        useFactory: (source: PrismaRealtimeAccess) =>
          new AccessGate(source, Date.now, options.accessCacheMs ?? 0),
      },
      {
        provide: REALTIME_HUB_OPTIONS,
        useValue: { limits: options.hubLimits },
      },
      {
        provide: CHATBOT_REQUEST_READ_STORE,
        useClass: PrismaChatbotRequestReadStore,
      },
      { provide: CUSTOMER_KEY_SEALER, useValue: sealer },
      { provide: INBOX_CLOCK, useValue: () => new Date() },
      { provide: SLA_PAUSE_READER, useClass: PrismaSlaPauseReader },
      {
        provide: CHATBOT_REQUEST_COMMAND_STORE,
        useClass: PrismaChatbotRequestCommandStore,
      },
      {
        provide: CHATBOT_REQUEST_RESOLVER,
        useValue: { resolve: () => Promise.resolve() },
      },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useClass(HeaderAuthGuard)
    .compile();

  const app: INestApplication = moduleRef.createNestApplication();
  // As main.ts: domain errors (403 INSUFFICIENT_PERMISSIONS...) map to HTTP.
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new PrismaExceptionFilter(),
  );
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as import('node:http').Server;
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const hub = moduleRef.get(RealtimeHub);
  const cls = moduleRef.get<ClsService<TenantClsStore>>(ClsService);
  const tenantPrisma = moduleRef.get(TenantPrismaService);
  const commands = moduleRef.get(ChatbotRequestCommandsService);
  const notifications = moduleRef.get(NotificationsService);
  const adapter = moduleRef.get(RealtimeNotificationEvents);

  const tenants: string[] = [];
  const users: string[] = [];
  let seq = 0;

  const grant = (subject: string, action: string) =>
    prisma.permission.upsert({
      where: { subject_action: { subject, action } },
      update: {},
      create: { subject, action },
    });

  const harness = {
    app,
    baseUrl,
    prisma,
    sealer,
    hub,
    cls,
    tenantPrisma,
    commands,
    notifications,
    adapter,
    root: moduleRef.get(PrismaService),

    async seedTenant(): Promise<string> {
      const id = randomUUID();
      await prisma.tenant.create({
        data: { id, name: 'Sucursal RT', slug: `rt-${id}` },
      });
      tenants.push(id);
      return id;
    },

    /** A user with one role holding `grants` in `tenantId`. */
    async seedUser(
      tenantId: string,
      grants: Grant[],
      over: { isActive?: boolean; name?: string } = {},
    ): Promise<{ userId: string; roleId: string }> {
      const permissions = await Promise.all(
        grants.map(([s, a]) => grant(s, a)),
      );
      const role = await prisma.role.create({
        data: {
          tenantId,
          name: `rt-${randomUUID()}`,
          permissions: {
            create: permissions.map((p) => ({ permissionId: p.id })),
          },
        },
      });
      const userId = randomUUID();
      users.push(userId);
      await prisma.user.create({
        data: {
          id: userId,
          email: `${userId}@rt.test`,
          hashedPassword: 'x',
          name: over.name ?? 'Persona',
          isActive: over.isActive ?? true,
        },
      });
      await prisma.tenantMembership.create({
        data: { userId, tenantId, roleId: role.id },
      });
      return { userId, roleId: role.id };
    },

    /** Creates a request the way intake does (folio and group in one tx). */
    async seedRequest(
      tenantId: string,
      over: Record<string, unknown> = {},
    ): Promise<{ id: string; customerKey: string }> {
      seq += 1;
      const customerKey =
        (over.customerKey as string) ??
        `52551${String(Date.now() % 100000).padStart(5, '0')}${String(seq).padStart(2, '0')}`;
      const created = await cls.runWith(
        { tenantId, userId: 'test', isSuperAdmin: false },
        () =>
          tenantPrisma.runInTransaction(async () => {
            const tx = tenantPrisma.getClient();
            const row = await tx.chatbotRequest.create({
              data: {
                tenantId,
                folio: await allocateFolio(tx, tenantId),
                kind: 'CLARIFICATION',
                subtype: 'UNKNOWN_QUESTION',
                summary: `Pregunta ${seq}`,
                source: 'chatbot',
                sourceRequestId: randomUUID(),
                ...over,
                customerKey,
              } as never,
            });
            await refreshCustomerGroup(tx, tenantId, customerKey);
            return row;
          }),
      );
      return { id: created.id, customerKey };
    },

    /** Runs a real staff command (one transaction, audit event, trigger). */
    command(
      tenantId: string,
      actorUserId: string,
      requestId: string,
      expectedVersion: number,
      command: StaffCommand,
      actorCanReassign = true,
    ) {
      return cls.runWith(
        { tenantId, userId: actorUserId, isSuperAdmin: false },
        () =>
          commands.execute({
            requestId,
            actorUserId,
            actorCanReassign,
            idempotencyKey: randomUUID(),
            expectedVersion,
            command,
          }),
      );
    },

    headers(
      tenantId: string,
      userId: string,
      extra: Record<string, string> = {},
    ): Record<string, string> {
      return { 'x-test-tenant': tenantId, 'x-test-user': userId, ...extra };
    },

    async close(): Promise<void> {
      await app.close();
      await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    },
  };
  return harness;
}

export type StreamHarness = Awaited<ReturnType<typeof createStreamHarness>>;
