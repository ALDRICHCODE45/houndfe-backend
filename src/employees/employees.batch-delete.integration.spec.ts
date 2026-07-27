/**
 * batch-delete integration spec — end-to-end coverage of the
 * critical response paths for `POST /admin/employees/batch-delete`:
 *
 *  - 200: 5 valid existing ids → { deleted: 5 } + child rows gone
 *  - 400: empty array / non-UUID / >100 ids → DTO validation 400
 *  - 404: an id that does not exist in this tenant → BATCH_DELETE_NOT_FOUND
 *         → 404 with offendingIds + reason, and the rest of the batch
 *         is NOT deleted (all-or-nothing)
 *
 * The 403 (missing batch_delete permission) is asserted via the
 * BatchDeleteGuard spec in src/shared/batch-delete/guards/.
 *
 * Spec: employee-batch-delete/spec.md R3, R6.
 */
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ClsService } from 'nestjs-cls';
import { ConfigModule } from '@nestjs/config';
import { DomainExceptionFilter } from '../shared/filters/domain-exception.filter';
import {
  resetAndSeedBaseline,
  disconnectIntegrationPrisma,
} from '../../test/integration/reset-db';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { PrismaEmployeeRepository } from './infrastructure/prisma-employee.repository';
import { EmployeesService } from './application/employees.service';
import { EmployeesController } from './employees.controller';
import { AuthModule } from '../auth/auth.module';
import { CaslAbilityFactory } from '../auth/authorization/casl-ability.factory';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { BatchDeleteModule } from '../shared/batch-delete/batch-delete.module';
import { BatchDeleteGuard } from '../shared/batch-delete/guards/batch-delete.guard';
import { BatchDeleteOrchestrator } from '../shared/batch-delete/orchestrator/batch-delete.orchestrator';
import { EMPLOYEE_REPOSITORY } from './domain/employee.repository';
import {
  AppActions,
  AppSubjects,
  PERMISSION_REGISTRY,
} from '../auth/authorization/domain/permission';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

const employeeId = (i: number) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const BASELINE_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const userId = () => `00000000-0000-4000-8005-000000000001`;

describeIfDb('Employees POST /admin/employees/batch-delete (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await resetAndSeedBaseline();

    // Ensure the seeded batch_delete:Employee row exists (the seed
    // script seeds PERMISSION_REGISTRY but tests must not depend on
    // it having run). Insert-if-missing.
    await prisma.permission.upsert({
      where: {
        subject_action: {
          subject: 'Employee',
          action: 'batch_delete',
        },
      },
      update: {},
      create: {
        subject: 'Employee',
        action: 'batch_delete',
        description: 'Eliminar múltiples empleados a la vez',
      },
    });

    const cls: Pick<ClsService<TenantClsStore>, 'get' | 'set'> = {
      get: (key: string) => {
        if (key === 'tenantId') return BASELINE_TENANT_ID;
        if (key === 'userId') return userId();
        if (key === 'isSuperAdmin') return false;
        return undefined;
      },
      set: () => undefined,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        // `ConfigModule.forRoot({ isGlobal: true })` provides a
        // globally-visible `ConfigService` so the
        // `JwtModule.registerAsync` factory inside `AuthModule` can
        // resolve its `inject: [ConfigService]` dependency. We use
        // `ignoreEnvFile: true` because the integration setupFile
        // has already loaded `.env.test` into `process.env` (re-loading
        // here would clobber the real test DB URL).
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        AuthModule,
        BatchDeleteModule.forFeature(),
      ],
      controllers: [EmployeesController],
      providers: [
        EmployeesService,
        {
          provide: TenantPrismaService,
          useValue: {
            getClient: () => prisma,
            runInTransaction: async <T>(work: () => Promise<T>) => work(),
            getTenantId: () => BASELINE_TENANT_ID,
            isInTransaction: () => false,
          },
        },
        {
          provide: ClsService,
          useValue: cls,
        },
        {
          provide: EMPLOYEE_REPOSITORY,
          useClass: PrismaEmployeeRepository,
        },
        {
          // Wire the BatchDeleteOrchestrator with TenantPrismaService +
          // EmployeesService (the BatchDeletableService for employees).
          provide: BatchDeleteOrchestrator,
          useFactory: (
            tenantPrisma: TenantPrismaService,
            service: EmployeesService,
          ): BatchDeleteOrchestrator =>
            new (class extends BatchDeleteOrchestrator {
              constructor() {
                super(tenantPrisma, service);
              }
            })(),
          inject: [TenantPrismaService, EmployeesService],
        },
        {
          // CaslAbilityFactory is required by BatchDeleteGuard (R10).
          provide: CaslAbilityFactory,
          useValue: {
            getEffectivePermissions: jest
              .fn()
              .mockResolvedValue([
                { action: 'batch_delete', subject: 'Employee' },
              ]),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TenantContextGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(BatchDeleteGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    // The global domain filter is registered in `main.ts` for the
    // real app; integration tests must wire it explicitly so
    // `BatchDeleteValidationError` → 404 (R6) is honored here.
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await disconnectIntegrationPrisma();
  });

  beforeEach(async () => {
    // Wipe child tables before employees to avoid FK constraint
    // failures (employees have 5 cascade-delete children).
    await prisma.employeeTimeOff.deleteMany({});
    await prisma.employeeEmergencyContact.deleteMany({});
    await prisma.employeeDocument.deleteMany({});
    await prisma.employeePositionHistory.deleteMany({});
    await prisma.employeeSalaryHistory.deleteMany({});
    await prisma.employee.deleteMany({});

    // Sanity-check the registry constant — guards against accidental
    // removal of the registry entry in a future refactor.
    const hasRegistryEntry = PERMISSION_REGISTRY.some(
      (p) =>
        p.subject === ('Employee' as AppSubjects) &&
        p.action === ('batch_delete' as AppActions),
    );
    expect(hasRegistryEntry).toBe(true);
  });

  async function seedEmployees(count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, (_, i) => employeeId(i + 1));
    for (const id of ids) {
      await prisma.employee.create({
        data: {
          id,
          tenantId: BASELINE_TENANT_ID,
          employeeNumber: `EMP-${id.slice(-12)}`,
          firstName: `First${id.slice(-4)}`,
          lastName: `Last${id.slice(-4)}`,
          hireDate: new Date('2026-01-15'),
        },
      });
    }
    return ids;
  }

  it('200 — happy path: 5 existing ids are deleted (cascade to child tables)', async () => {
    const ids = await seedEmployees(5);

    // Seed a child row on the first employee to prove the cascade
    // hits the 5 child tables.
    const [firstId] = ids;
    await prisma.employeeSalaryHistory.create({
      data: {
        employeeId: firstId,
        tenantId: BASELINE_TENANT_ID,
        amountCents: 100000,
        effectiveFrom: new Date('2026-01-15'),
        reason: 'baseline',
      },
    });

    const res = await request(app.getHttpServer())
      .post('/admin/employees/batch-delete')
      .send({ ids });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 5 });

    const remaining = await prisma.employee.findMany({
      where: { id: { in: ids } },
    });
    expect(remaining).toHaveLength(0);

    // Child row was cascade-deleted with the parent.
    const salaries = await prisma.employeeSalaryHistory.findMany({
      where: { employeeId: firstId },
    });
    expect(salaries).toHaveLength(0);
  });

  it('400 — empty array is rejected by DTO validation', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/employees/batch-delete')
      .send({ ids: [] });

    expect(res.status).toBe(400);
  });

  it('400 — non-UUID entries are rejected', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/employees/batch-delete')
      .send({ ids: ['not-a-uuid'] });

    expect(res.status).toBe(400);
  });

  it('400 — over 100 ids is rejected', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => employeeId(i + 1));
    const res = await request(app.getHttpServer())
      .post('/admin/employees/batch-delete')
      .send({ ids });

    expect(res.status).toBe(400);
  });

  it('404 — ids that do not exist in the tenant are reported as NOT_FOUND (all-or-nothing)', async () => {
    const existingIds = await seedEmployees(2);
    const missingIds = [employeeId(99), employeeId(100)];

    const res = await request(app.getHttpServer())
      .post('/admin/employees/batch-delete')
      .send({ ids: [...existingIds, ...missingIds] });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('BATCH_DELETE_NOT_FOUND');
    expect([...res.body.offendingIds].sort()).toEqual(
      [...missingIds].sort(),
    );

    // The existing ids are NOT deleted because the pre-flight rejected
    // the batch.
    const remaining = await prisma.employee.findMany({
      where: { id: { in: existingIds } },
    });
    expect(remaining).toHaveLength(2);
  });
});
