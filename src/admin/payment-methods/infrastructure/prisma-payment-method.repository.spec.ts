/**
 * WU1 — PrismaPaymentMethodRepository spec.
 *
 * Mocks `TenantPrismaService.getClient()` to return a fake prisma client,
 * then exercises:
 *   - `create` happy path + P2002 → DUPLICATE_NAME.
 *   - `update` happy path + P2025 → EntityNotFoundError + P2002 → DUPLICATE_NAME.
 *   - `findById` tenant scoping: cross-tenant returns null (the WHERE has
 *     `tenantId` injected, so a different tenant's row simply misses).
 *   - `findAll` orderBy updatedAt DESC.
 *   - `findAllActive` filter by isActive=true + orderBy name ASC.
 */
import { Prisma } from '@prisma/client';
import { PrismaPaymentMethodRepository } from './prisma-payment-method.repository';
import { PaymentMethod } from '../domain/payment-method.entity';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../../../shared/domain/domain-error';

const NOW = new Date('2026-08-24T00:00:00.000Z');

type RecordShape = {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  subtitle: string | null;
  isActive: boolean;
  metadataJson: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function makeRecord(overrides: Partial<RecordShape> = {}): RecordShape {
  return {
      id: 'pm-1',
      tenantId: 'tenant-1',
      name: 'Mercado Pago',
      category: 'TRANSFER',
      subtitle: null,
      isActive: true,
      metadataJson: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
}

function makeTenantPrisma() {
  const client = {
    paymentMethod: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const tenantPrisma = {
    getClient: jest.fn(() => client),
    getTenantId: jest.fn(() => 'tenant-1'),
  };
  return { tenantPrisma, client };
}

describe('PrismaPaymentMethodRepository', () => {
  describe('create', () => {
    it('persists the entity and returns the reloaded domain object', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentMethod.create.mockResolvedValue(makeRecord());
      const repo = new PrismaPaymentMethodRepository(tenantPrisma as any);

      const entity = PaymentMethod.create({
        id: 'pm-1',
        tenantId: 'tenant-1',
        name: 'Mercado Pago',
        category: 'transfer',
      });

      const result = await repo.create(entity);

      expect(client.paymentMethod.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'pm-1',
          tenantId: 'tenant-1',
          name: 'Mercado Pago',
          category: 'TRANSFER',
          subtitle: null,
          isActive: true,
        }),
      });
      expect(result).toBeInstanceOf(PaymentMethod);
      expect(result.id).toBe('pm-1');
      expect(result.category).toBe('transfer'); // coerced to lowercase
    });

    it('translates Prisma P2002 on create into DUPLICATE_NAME', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          clientVersion: Prisma.prismaVersion.client,
          code: 'P2002',
          meta: { target: ['tenantId', 'name'] },
        },
      );
      client.paymentMethod.create.mockRejectedValue(p2002);
      const repo = new PrismaPaymentMethodRepository(tenantPrisma as any);

      const entity = PaymentMethod.create({
        id: 'pm-1',
        tenantId: 'tenant-1',
        name: 'Mercado Pago',
        category: 'transfer',
      });

      await expect(repo.create(entity)).rejects.toMatchObject({
        code: 'DUPLICATE_NAME',
      });
      await expect(repo.create(entity)).rejects.toBeInstanceOf(
        BusinessRuleViolationError,
      );
    });
  });

  describe('update', () => {
    it('updates by id and returns the reloaded entity', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentMethod.update.mockResolvedValue(
        makeRecord({ subtitle: 'QR' }),
      );
      const repo = new PrismaPaymentMethodRepository(tenantPrisma as any);

      const entity = PaymentMethod.create({
        id: 'pm-1',
        tenantId: 'tenant-1',
        name: 'Mercado Pago',
        category: 'transfer',
      });
      entity.update({ subtitle: 'QR' });

      const result = await repo.update(entity);

      expect(client.paymentMethod.update).toHaveBeenCalledWith({
        where: { id: 'pm-1' },
        data: expect.objectContaining({
          subtitle: 'QR',
        }),
      });
      expect(result.subtitle).toBe('QR');
    });

    it('translates P2025 (row missing) into EntityNotFoundError', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      const p2025 = new Prisma.PrismaClientKnownRequestError(
        'Record not found',
        { clientVersion: Prisma.prismaVersion.client, code: 'P2025' },
      );
      client.paymentMethod.update.mockRejectedValue(p2025);
      const repo = new PrismaPaymentMethodRepository(tenantPrisma as any);

      const entity = PaymentMethod.create({
        id: 'pm-missing',
        tenantId: 'tenant-1',
        name: 'Mercado Pago',
        category: 'transfer',
      });

      await expect(repo.update(entity)).rejects.toBeInstanceOf(
        EntityNotFoundError,
      );
    });

    it('translates P2002 on update into DUPLICATE_NAME', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          clientVersion: Prisma.prismaVersion.client,
          code: 'P2002',
        },
      );
      client.paymentMethod.update.mockRejectedValue(p2002);
      const repo = new PrismaPaymentMethodRepository(tenantPrisma as any);

      const entity = PaymentMethod.create({
        id: 'pm-1',
        tenantId: 'tenant-1',
        name: 'OXXO Pay',
        category: 'transfer',
      });

      await expect(repo.update(entity)).rejects.toMatchObject({
        code: 'DUPLICATE_NAME',
      });
    });
  });

  describe('findById', () => {
    it('scopes the query by tenantId (cross-tenant returns null)', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentMethod.findFirst.mockResolvedValue(null);
      const repo = new PrismaPaymentMethodRepository(tenantPrisma as any);

      const result = await repo.findById('pm-1', 'tenant-2');

      expect(client.paymentMethod.findFirst).toHaveBeenCalledWith({
        where: { id: 'pm-1', tenantId: 'tenant-2' },
      });
      expect(result).toBeNull();
    });

    it('returns the reloaded entity on hit', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentMethod.findFirst.mockResolvedValue(makeRecord());
      const repo = new PrismaPaymentMethodRepository(tenantPrisma as any);

      const result = await repo.findById('pm-1', 'tenant-1');

      expect(result).toBeInstanceOf(PaymentMethod);
      expect(result?.id).toBe('pm-1');
      expect(result?.category).toBe('transfer');
    });
  });

  describe('findAll', () => {
    it('orders by updatedAt DESC', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentMethod.findMany.mockResolvedValue([makeRecord()]);
      const repo = new PrismaPaymentMethodRepository(tenantPrisma as any);

      const result = await repo.findAll('tenant-1');

      expect(client.paymentMethod.findMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1' },
        orderBy: { updatedAt: 'desc' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('findAllActive', () => {
    it('filters by isActive=true and orders by name ASC', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentMethod.findMany.mockResolvedValue([makeRecord()]);
      const repo = new PrismaPaymentMethodRepository(tenantPrisma as any);

      const result = await repo.findAllActive('tenant-1');

      expect(client.paymentMethod.findMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', isActive: true },
        orderBy: { name: 'asc' },
      });
      expect(result).toHaveLength(1);
    });

    it('returns an empty array when no active rows exist', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentMethod.findMany.mockResolvedValue([]);
      const repo = new PrismaPaymentMethodRepository(tenantPrisma as any);

      const result = await repo.findAllActive('tenant-1');
      expect(result).toEqual([]);
    });
  });
});