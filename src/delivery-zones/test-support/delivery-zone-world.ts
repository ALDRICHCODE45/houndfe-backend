/**
 * shipping-zones / T1 — integration test support (excluded from the build by
 * `tsconfig.build.json` `**\/test-support/**`).
 *
 * Boots a minimal Nest graph with the REAL JwtAuthGuard -> TenantContextGuard
 * -> PermissionsGuard chain, CLS, DatabaseModule and the main.ts pipe/filters,
 * and seeds isolated tenants/users with real role grants. Cleanup deletes only
 * the rows it created (tenant cascade + users), never truncates.
 */
import { type INestApplication, type ModuleMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { ClsModule } from 'nestjs-cls';
import { ServiceCredential } from '../../chatbot-api/domain/service-credential.entity';
import type { IServiceCredentialRepository } from '../../chatbot-api/domain/service-credential.repository';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../../auth/infrastructure/strategies/jwt.strategy';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';

export const TEST_JWT_SECRET =
  'delivery-zones-test-secret-not-a-production-key';

const jwt = new JwtService({
  secret: TEST_JWT_SECRET,
  signOptions: { expiresIn: '1h' },
});

let client: PrismaClient | undefined;

export function worldPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
  }
  return client;
}

export async function disconnectWorldPrisma(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}

export const SKIP_DB_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;

export async function createZoneTestApp(
  metadata: ModuleMetadata,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      PassportModule.register({ defaultStrategy: 'jwt' }),
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      DatabaseModule,
      ...(metadata.imports ?? []),
    ],
    controllers: metadata.controllers ?? [],
    providers: [
      JwtStrategy,
      JwtAuthGuard,
      TenantContextGuard,
      PermissionsGuard,
      CaslAbilityFactory,
      {
        provide: ConfigService,
        useValue: {
          getOrThrow: () => TEST_JWT_SECRET,
          get: () => TEST_JWT_SECRET,
        },
      },
      ...(metadata.providers ?? []),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  // Same pipe as main.ts, so 400 bodies match production.
  app.useGlobalPipes(createAppValidationPipe());
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new PrismaExceptionFilter(),
  );
  await app.init();
  return app;
}

export interface SeededMember {
  userId: string;
  token: string;
}

/** Tracks every row it creates so `cleanup()` removes exactly those. */
export class ZoneWorld {
  private readonly tenantIds: string[] = [];
  private readonly userIds: string[] = [];

  async tenant(name: string): Promise<string> {
    const id = randomUUID();
    await worldPrisma().tenant.create({
      data: { id, name, slug: `dz-${id}` },
    });
    this.tenantIds.push(id);
    return id;
  }

  /** Member of `tenantId` holding exactly `grants` (`subject:action`). */
  async member(
    tenantId: string,
    name: string,
    grants: string[],
  ): Promise<SeededMember> {
    const prisma = worldPrisma();
    const role = await prisma.role.create({
      data: { tenantId, name: `${name}-${randomUUID()}` },
    });
    for (const grant of grants) {
      const [subject, action] = grant.split(':');
      const permission = await prisma.permission.upsert({
        where: { subject_action: { subject, action } },
        update: {},
        create: { subject, action, description: `${action} ${subject}` },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@dz.test`,
        name,
        hashedPassword: 'not-a-real-hash',
        isActive: true,
      },
    });
    this.userIds.push(userId);
    await prisma.tenantMembership.create({
      data: { userId, tenantId, roleId: role.id },
    });
    const token = jwt.sign({
      sub: userId,
      email: `${userId}@dz.test`,
      tenantId,
      tenantSlug: `dz-${tenantId}`,
      isSuperAdmin: false,
    });
    return { userId, token };
  }

  async cleanup(): Promise<void> {
    const prisma = worldPrisma();
    if (this.tenantIds.length > 0) {
      await prisma.outboxEvent.deleteMany({
        where: { tenantId: { in: this.tenantIds } },
      });
      await prisma.tenant.deleteMany({ where: { id: { in: this.tenantIds } } });
    }
    if (this.userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: this.userIds } } });
    }
    this.tenantIds.length = 0;
    this.userIds.length = 0;
  }
}

/** In-memory service credentials for the REAL ServiceAuthGuard. */
export class BotCredentials {
  private readonly byHash = new Map<string, ServiceCredential>();

  readonly repository: IServiceCredentialRepository = {
    findByHashedKey: (hashedKey) =>
      Promise.resolve(this.byHash.get(hashedKey) ?? null),
    touchLastUsedAt: () => Promise.resolve(),
  };

  /** Register a bot token for `tenantId` and return the bearer token. */
  register(
    tenantId: string,
    scopes: string[] = [
      'human-decisions:create',
      'human-decisions:read',
      'human-decisions:ack',
    ],
  ): string {
    const token = `svc_dz_${randomUUID()}`;
    const credential = ServiceCredential.fromPersistence({
      id: `cred-${randomUUID()}`,
      tenantId,
      name: 'delivery-zone bot',
      hashedKey: createHash('sha256').update(token).digest('hex'),
      scopes,
      isActive: true,
      lastUsedAt: null,
      rateLimit: 1000,
      createdAt: new Date(),
      revokedAt: null,
    });
    this.byHash.set(credential.hashedKey, credential);
    return token;
  }
}
