/**
 * ADAPTER: PrismaPaymentDetailRepository — Q1 / WU1.
 *
 * Concrete implementation of `IPaymentDetailRepository` using Prisma. Tenant
 * scoping is delegated to `TenantPrismaService` (which extends the prisma
 * client with a CLS-driven WHERE-injection — see
 * `src/shared/tenant/tenant-scoped-models.constant.ts`). Because `PaymentDetail`
 * was added to that allowlist, every read/write gets auto-filtered by
 * `tenantId`, so we don't pass it explicitly into `where`/`data`.
 *
 * P2002 mapping: the `@@unique([tenantId, clabe])` constraint surfaces as
 * `PrismaClientKnownRequestError` code `P2002`. We re-throw a
 * `BusinessRuleViolationError('DUPLICATE_CLABE', 'DUPLICATE_CLABE')` so the
 * `DomainExceptionFilter` returns 409.
 *
 * Logical delete (D2): the controller's `DELETE` calls `repo.update()` with
 * the entity returned by `entity.deactivate()`; the adapter performs a normal
 * `prisma.paymentDetail.update({ data: { isActive: false, updatedAt: ... } })`.
 * No hard delete is exposed.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../../../shared/domain/domain-error';
import { PaymentDetail } from '../domain/payment-detail.entity';
import type { IPaymentDetailRepository } from '../domain/payment-detail.repository';

type PaymentDetailRecord = Prisma.PaymentDetailGetPayload<true>;

@Injectable()
export class PrismaPaymentDetailRepository implements IPaymentDetailRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async create(paymentDetail: PaymentDetail): Promise<PaymentDetail> {
    const prisma = this.tenantPrisma.getClient();
    const data = paymentDetail.toPersistence();
    try {
      const created = await prisma.paymentDetail.create({ data });
      return this.toDomain(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BusinessRuleViolationError(
          'A PaymentDetail with this CLABE already exists for the tenant',
          'DUPLICATE_CLABE',
        );
      }
      throw error;
    }
  }

  async update(paymentDetail: PaymentDetail): Promise<PaymentDetail> {
    const prisma = this.tenantPrisma.getClient();
    const data = paymentDetail.toPersistence();
    try {
      const updated = await prisma.paymentDetail.update({
        where: { id: data.id },
        data: {
          bankName: data.bankName,
          beneficiary: data.beneficiary,
          clabe: data.clabe,
          accountNumber: data.accountNumber,
          isActive: data.isActive,
          updatedAt: data.updatedAt,
        },
      });
      return this.toDomain(updated);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new EntityNotFoundError('PaymentDetail', data.id);
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BusinessRuleViolationError(
          'A PaymentDetail with this CLABE already exists for the tenant',
          'DUPLICATE_CLABE',
        );
      }
      throw error;
    }
  }

  async findById(id: string, tenantId: string): Promise<PaymentDetail | null> {
    const prisma = this.tenantPrisma.getClient();
    // The tenant-scoped extension auto-injects `tenantId` into the WHERE,
    // so a cross-tenant row is filtered out (returns null, not leaked).
    // We pass tenantId explicitly via a `where` clause to keep the API
    // contract clear even when the extension is bypassed.
    const record = await prisma.paymentDetail.findFirst({
      where: { id, tenantId },
    });
    return record ? this.toDomain(record) : null;
  }

  async findAll(tenantId: string): Promise<PaymentDetail[]> {
    const prisma = this.tenantPrisma.getClient();
    const records = await prisma.paymentDetail.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
    });
    return records.map((r) => this.toDomain(r));
  }

  async findActive(tenantId: string): Promise<PaymentDetail | null> {
    const prisma = this.tenantPrisma.getClient();
    const record = await prisma.paymentDetail.findFirst({
      where: { tenantId, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
    return record ? this.toDomain(record) : null;
  }

  private toDomain(record: PaymentDetailRecord): PaymentDetail {
    return PaymentDetail.fromPersistence({
      id: record.id,
      tenantId: record.tenantId,
      bankName: record.bankName,
      beneficiary: record.beneficiary,
      clabe: record.clabe,
      accountNumber: record.accountNumber,
      isActive: record.isActive,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
}
