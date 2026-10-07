/**
 * cash-register-closing / T2 — tenant-scoping guard for the seven new cash
 * models (S1, S8).
 *
 * Tenant scoping is an ALLOWLIST and it FAILS OPEN: any model missing from
 * `TENANT_SCOPED_MODELS` skips the `tenantId` where-injection, so a
 * cross-tenant cash row (register, session, movement, count, handover,
 * closing, command) could be read or rewritten through
 * `TenantPrismaService`. This spec pins both halves:
 *   1. the seven names are present in the canonical allowlist exactly once;
 *   2. the factory actually injects `tenantId` for them on read/write and
 *      overrides a caller-supplied foreign `tenantId`.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- the DB-free parameterized harness mirrors `tenant-prisma.factory.spec.ts`: the mocked Prisma delegates and CLS store are intentionally `any` because the spec only observes the args the extension injects. */
import type { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../tenant/tenant-cls-store.interface';
import { TENANT_SCOPED_MODELS } from '../tenant/tenant-scoped-models.constant';
import { createTenantScopedPrisma } from './tenant-prisma.factory';

const CASH_MODELS = [
  'CashRegister',
  'CashSession',
  'CashMovement',
  'CashCount',
  'CashHandover',
  'CashClosing',
  'CashCommand',
] as const;

describe('TENANT_SCOPED_MODELS — cash-register-closing registration (T2)', () => {
  it.each(CASH_MODELS)(
    'registers %s so tenant-scoped access injects tenantId',
    (model) => {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    },
  );

  it('contains each cash model exactly once', () => {
    const occurrences = [...TENANT_SCOPED_MODELS].filter((model) =>
      (CASH_MODELS as readonly string[]).includes(model),
    );
    expect(occurrences).toEqual([...CASH_MODELS]);
  });
});

describe('createTenantScopedPrisma — cash-register-closing tenant injection', () => {
  const createHarness = (store: Partial<TenantClsStore> = {}) => {
    const cls = {
      get: jest.fn((key: keyof TenantClsStore) => (store as any)[key]),
    } as unknown as ClsService<TenantClsStore>;

    const base = {
      $extends: jest.fn(),
    } as unknown as PrismaClient;

    let allOperations: any;
    (base.$extends as unknown as jest.Mock).mockImplementation((extension) => {
      allOperations = extension.query.$allOperations;
      return { __extended: true, allOperations };
    });

    createTenantScopedPrisma(base, cls);

    return { allOperations };
  };

  it.each(CASH_MODELS)(
    'injects tenantId into findMany where for %s',
    async (model) => {
      const { allOperations } = createHarness({
        tenantId: 'tenant-a',
        isSuperAdmin: false,
      });
      const query = jest.fn().mockResolvedValue([]);

      await allOperations({
        model,
        operation: 'findMany',
        args: { where: { id: 'row-1' } },
        query,
      });

      expect(query).toHaveBeenCalledWith({
        where: { id: 'row-1', tenantId: 'tenant-a' },
      });
    },
  );

  it.each(CASH_MODELS)(
    'overrides a cross-tenant tenantId on create for %s',
    async (model) => {
      const { allOperations } = createHarness({
        tenantId: 'tenant-a',
        isSuperAdmin: false,
      });
      const query = jest.fn().mockResolvedValue({});

      await allOperations({
        model,
        operation: 'create',
        args: { data: { id: 'row-1', tenantId: 'evil-tenant' } },
        query,
      });

      expect(query).toHaveBeenCalledWith({
        data: { id: 'row-1', tenantId: 'tenant-a' },
      });
    },
  );
});
