/**
 * batch-status integration spec — end-to-end coverage of the
 * critical response paths for `POST /admin/employees/batch-terminate`
 * and `POST /admin/employees/batch-reactivate`:
 *
 *  - 200: 5 ACTIVE ids → batch-terminate → all flipped to TERMINATED,
 *         `terminationDate` stamped; then → batch-reactivate → all
 *         flipped back to ACTIVE, `terminationDate` cleared.
 *  - 400: empty array / non-UUID / >100 ids → DTO validation 400
 *  - 404: an id that does not exist in this tenant →
 *         `BATCH_DELETE_NOT_FOUND` → 404 with offendingIds + reason,
 *         and the rest of the batch is NOT modified (all-or-nothing).
 *
 * Permission enforcement on these endpoints reuses `update:Employee`
 * — terminating or reactivating is logically an UPDATE, not a DELETE.
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
import { EMPLOYEE_REPOSITORY } from './domain/employee.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

const employeeId = (i: number) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const BASELINE_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const userId = () => `00000000-0000-4000-8005-000000000001`;

describeIfDb(
  'Employees POST /admin/employees/batch-{terminate,reactivate} (integration)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      await resetAndSeedBaseline();

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
          // has already loaded `.env.test` into `process.env`.
          ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
          AuthModule,
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
            // CaslAbilityFactory is required by the PermissionsGuard
            // override wiring at runtime; we keep the guard
            // short-circuited below so this factory is never invoked,
            // but Nest still resolves the token.
            provide: CaslAbilityFactory,
            useValue: {
              getEffectivePermissions: jest.fn().mockResolvedValue([
                { action: 'update', subject: 'Employee' },
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
        .compile();

      app = moduleRef.createNestApplication();
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, transform: true }),
      );
      // The global domain filter is registered in `main.ts` for the
      // real app; integration tests must wire it explicitly so
      // `BatchDeleteValidationError` → 404 is honored here.
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
    });

    async function seedActiveEmployees(count: number): Promise<string[]> {
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
            status: 'ACTIVE',
            terminationDate: null,
          },
        });
      }
      return ids;
    }

    it('200 — terminate flips all 5 ids to TERMINATED and stamps terminationDate', async () => {
      const ids = await seedActiveEmployees(5);

      const res = await request(app.getHttpServer())
        .post('/admin/employees/batch-terminate')
        .send({ ids });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 5 });

      const rows = await prisma.employee.findMany({
        where: { id: { in: ids } },
      });
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.status).toBe('TERMINATED');
        expect(row.terminationDate).not.toBeNull();
      }
    });

    it('200 — terminate → reactivate roundtrip flips back to ACTIVE and clears terminationDate', async () => {
      const ids = await seedActiveEmployees(3);

      // First call: terminate.
      const term = await request(app.getHttpServer())
        .post('/admin/employees/batch-terminate')
        .send({ ids });
      expect(term.status).toBe(200);
      expect(term.body).toEqual({ updated: 3 });

      // Second call: reactivate.
      const react = await request(app.getHttpServer())
        .post('/admin/employees/batch-reactivate')
        .send({ ids });
      expect(react.status).toBe(200);
      expect(react.body).toEqual({ updated: 3 });

      const rows = await prisma.employee.findMany({
        where: { id: { in: ids } },
      });
      for (const row of rows) {
        expect(row.status).toBe('ACTIVE');
        expect(row.terminationDate).toBeNull();
      }
    });

    it('400 — batch-terminate rejects empty array via DTO validation', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/employees/batch-terminate')
        .send({ ids: [] });

      expect(res.status).toBe(400);
    });

    it('400 — batch-reactivate rejects non-UUID entries', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/employees/batch-reactivate')
        .send({ ids: ['not-a-uuid'] });

      expect(res.status).toBe(400);
    });

    it('400 — batch-terminate rejects over 100 ids', async () => {
      const ids = Array.from({ length: 101 }, (_, i) => employeeId(i + 1));
      const res = await request(app.getHttpServer())
        .post('/admin/employees/batch-terminate')
        .send({ ids });

      expect(res.status).toBe(400);
    });

    it('404 — batch-terminate rejects ids that do not exist in the tenant (all-or-nothing)', async () => {
      const existingIds = await seedActiveEmployees(2);
      const missingIds = [employeeId(99), employeeId(100)];

      const res = await request(app.getHttpServer())
        .post('/admin/employees/batch-terminate')
        .send({ ids: [...existingIds, ...missingIds] });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('BATCH_DELETE_NOT_FOUND');
      expect([...res.body.offendingIds].sort()).toEqual(
        [...missingIds].sort(),
      );

      // The existing ids are NOT touched because the pre-flight
      // rejected the batch.
      const rows = await prisma.employee.findMany({
        where: { id: { in: existingIds } },
      });
      for (const row of rows) {
        expect(row.status).toBe('ACTIVE');
        expect(row.terminationDate).toBeNull();
      }
    });
  },
);
