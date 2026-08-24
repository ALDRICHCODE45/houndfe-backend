/**
 * Q1 / WU1 — PrismaPaymentDetailRepository spec.
 *
 * Mocks `TenantPrismaService.getClient()` to return a fake prisma client,
 * then exercises:
 *   - `create` happy path.
 *   - `create` P2002 → DUPLICATE_CLABE.
 *   - `update` happy path + P2025 → EntityNotFoundError + P2002 → DUPLICATE_CLABE.
 *   - `findById` tenant scoping: cross-tenant returns null (the WHERE has
 *     `tenantId` injected, so a different tenant's row simply misses).
 *   - `findAll` orderBy updatedAt DESC.
 *   - `findActive` filter by isActive=true + orderBy updatedAt DESC.
 */
import { Prisma } from '@prisma/client';
import { PrismaPaymentDetailRepository } from './prisma-payment-detail.repository';
import { PaymentDetail } from '../domain/payment-detail.entity';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../../../shared/domain/domain-error';

const NOW = new Date('2026-08-24T00:00:00.000Z');

type RecordShape = {
  id: string;
  tenantId: string;
  bankName: string;
  beneficiary: string;
  clabe: string;
  accountNumber: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function makeRecord(overrides: Partial<RecordShape> = {}): RecordShape {
  return {
    id: 'pd-1',
    tenantId: 'tenant-1',
    bankName: 'BBVA',
    beneficiary: 'Tienda XYZ',
    clabe: '012345678901234567',
    accountNumber: '1234567890',
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeTenantPrisma() {
  const client = {
    paymentDetail: {
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

describe('PrismaPaymentDetailRepository', () => {
  describe('create', () => {
    it('persists the entity and returns the reloaded domain object', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentDetail.create.mockResolvedValue(makeRecord());
      const repo = new PrismaPaymentDetailRepository(tenantPrisma as any);

      const entity = PaymentDetail.create({
        id: 'pd-1',
        tenantId: 'tenant-1',
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
      });

      const result = await repo.create(entity);

      expect(client.paymentDetail.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'pd-1',
          tenantId: 'tenant-1',
          bankName: 'BBVA',
          clabe: '012345678901234567',
          accountNumber: '1234567890',
        }),
      });
      expect(result).toBeInstanceOf(PaymentDetail);
      expect(result.id).toBe('pd-1');
    });

    it('translates Prisma P2002 on create into DUPLICATE_CLABE', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          clientVersion: Prisma.prismaVersion.client,
          code: 'P2002',
          meta: { target: ['tenantId', 'clabe'] },
        },
      );
      client.paymentDetail.create.mockRejectedValue(p2002);
      const repo = new PrismaPaymentDetailRepository(tenantPrisma as any);

      const entity = PaymentDetail.create({
        id: 'pd-1',
        tenantId: 'tenant-1',
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
      });

      await expect(repo.create(entity)).rejects.toMatchObject({
        code: 'DUPLICATE_CLABE',
      });
      await expect(repo.create(entity)).rejects.toBeInstanceOf(
        BusinessRuleViolationError,
      );
    });
  });

  describe('update', () => {
    it('updates by id and returns the reloaded entity', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentDetail.update.mockResolvedValue(
        makeRecord({ beneficiary: 'Nuevo Beneficiario' }),
      );
      const repo = new PrismaPaymentDetailRepository(tenantPrisma as any);

      const entity = PaymentDetail.create({
        id: 'pd-1',
        tenantId: 'tenant-1',
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
      });
      entity.update({ beneficiary: 'Nuevo Beneficiario' });

      const result = await repo.update(entity);

      expect(client.paymentDetail.update).toHaveBeenCalledWith({
        where: { id: 'pd-1' },
        data: expect.objectContaining({
          beneficiary: 'Nuevo Beneficiario',
        }),
      });
      expect(result.beneficiary).toBe('Nuevo Beneficiario');
    });

    it('translates P2025 (row missing) into EntityNotFoundError', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      const p2025 = new Prisma.PrismaClientKnownRequestError(
        'Record not found',
        { clientVersion: Prisma.prismaVersion.client, code: 'P2025' },
      );
      client.paymentDetail.update.mockRejectedValue(p2025);
      const repo = new PrismaPaymentDetailRepository(tenantPrisma as any);

      const entity = PaymentDetail.create({
        id: 'pd-missing',
        tenantId: 'tenant-1',
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
      });

      await expect(repo.update(entity)).rejects.toBeInstanceOf(
        EntityNotFoundError,
      );
    });

    it('translates P2002 on update into DUPLICATE_CLABE', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          clientVersion: Prisma.prismaVersion.client,
          code: 'P2002',
        },
      );
      client.paymentDetail.update.mockRejectedValue(p2002);
      const repo = new PrismaPaymentDetailRepository(tenantPrisma as any);

      const entity = PaymentDetail.create({
        id: 'pd-1',
        tenantId: 'tenant-1',
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '999999999999999999',
        accountNumber: '1234567890',
      });

      await expect(repo.update(entity)).rejects.toMatchObject({
        code: 'DUPLICATE_CLABE',
      });
    });
  });

  describe('findById', () => {
    it('scopes the query by tenantId (cross-tenant returns null)', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentDetail.findFirst.mockResolvedValue(null);
      const repo = new PrismaPaymentDetailRepository(tenantPrisma as any);

      const result = await repo.findById('pd-1', 'tenant-2');

      expect(client.paymentDetail.findFirst).toHaveBeenCalledWith({
        where: { id: 'pd-1', tenantId: 'tenant-2' },
      });
      expect(result).toBeNull();
    });

    it('returns the reloaded entity on hit', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentDetail.findFirst.mockResolvedValue(makeRecord());
      const repo = new PrismaPaymentDetailRepository(tenantPrisma as any);

      const result = await repo.findById('pd-1', 'tenant-1');

      expect(result).toBeInstanceOf(PaymentDetail);
      expect(result?.id).toBe('pd-1');
    });
  });

  describe('findAll', () => {
    it('orders by updatedAt DESC', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentDetail.findMany.mockResolvedValue([makeRecord()]);
      const repo = new PrismaPaymentDetailRepository(tenantPrisma as any);

      const result = await repo.findAll('tenant-1');

      expect(client.paymentDetail.findMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1' },
        orderBy: { updatedAt: 'desc' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('findActive', () => {
    it('filters by isActive=true and orders by updatedAt DESC', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentDetail.findFirst.mockResolvedValue(makeRecord());
      const repo = new PrismaPaymentDetailRepository(tenantPrisma as any);

      const result = await repo.findActive('tenant-1');

      expect(client.paymentDetail.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', isActive: true },
        orderBy: { updatedAt: 'desc' },
      });
      expect(result).toBeInstanceOf(PaymentDetail);
    });

    it('returns null when no active row exists', async () => {
      const { tenantPrisma, client } = makeTenantPrisma();
      client.paymentDetail.findFirst.mockResolvedValue(null);
      const repo = new PrismaPaymentDetailRepository(tenantPrisma as any);

      const result = await repo.findActive('tenant-1');

      expect(result).toBeNull();
    });
  });
});
