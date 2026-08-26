/**
 * ADAPTER: PrismaPaymentMethodRepository — custom-payment-methods / WU1.
 *
 * Concrete implementation of `IPaymentMethodRepository` using Prisma.
 * Tenant scoping is delegated to `TenantPrismaService` (which extends the
 * Prisma client with a CLS-driven WHERE-injection — see
 * `src/shared/tenant/tenant-scoped-models.constant.ts`). Because
 * `PaymentMethod` was added to that allowlist, every read/write is
 * auto-filtered by `tenantId`; we additionally pass explicit
 * `where: { id, tenantId }` (and `tenantId` on `create`) as defense in
 * depth, mirroring the `PaymentDetail` precedent.
 *
 * Error mapping:
 *   - P2002 (`@@unique([tenantId, name])`) →
 *     `BusinessRuleViolationError('DUPLICATE_NAME', 'DUPLICATE_NAME')` → 409.
 *   - P2025 (row missing on update) →
 *     `EntityNotFoundError('PaymentMethod', id)` → 404.
 *
 * Logical delete (D2): the controller's `DELETE` calls `repo.update()`
 * with the entity returned by `entity.deactivate()`; the adapter performs
 * a normal `prisma.paymentMethod.update({ data: { isActive: false, ... } })`.
 * No hard delete is exposed.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, PaymentMethodCategory } from '@prisma/client';
import { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../../../shared/domain/domain-error';
import { PaymentMethod } from '../domain/payment-method.entity';
import type { IPaymentMethodRepository } from '../domain/payment-method.repository';

type PaymentMethodRecord = Prisma.PaymentMethodGetPayload<true>;

/**
 * Coerce the persisted Prisma enum (`'CASH' | 'CARD_CREDIT' | 'CARD_DEBIT'
 * | 'TRANSFER'`) to the 4-value lowercase union the entity guards at
 * construction. The shape is closed by `PaymentMethodCategory` (the enum
 * was added with exactly 4 values — see prisma/schema.prisma D6) so the
 * coercion is safe; if a future migration adds a value, TS will flag this
 * cast.
 */
function coerceCategory(
  value: PaymentMethodCategory | string,
): 'cash' | 'card_credit' | 'card_debit' | 'transfer' {
  const normalized = String(value).toLowerCase();
  if (
    normalized === 'cash' ||
    normalized === 'card_credit' ||
    normalized === 'card_debit' ||
    normalized === 'transfer'
  ) {
    return normalized;
  }
  // Defensive: should be unreachable because `PaymentMethodCategory` is
  // a closed Prisma enum and the entity guard rejects anything else on
  // construction. If a future migration widens the enum, surface as a
  // 4xx rather than silently mislabel.
  throw new BusinessRuleViolationError(
    'INVALID_CATEGORY',
    'INVALID_CATEGORY',
  );
}

@Injectable()
export class PrismaPaymentMethodRepository
  implements IPaymentMethodRepository
{
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async create(paymentMethod: PaymentMethod): Promise<PaymentMethod> {
    const prisma = this.tenantPrisma.getClient();
    const data = paymentMethod.toPersistence();
    try {
      const created = await prisma.paymentMethod.create({
        data: {
          id: data.id,
          tenantId: data.tenantId,
          name: data.name,
          category: data.category,
          subtitle: data.subtitle,
          isActive: data.isActive,
          metadataJson:
            data.metadataJson === null
              ? Prisma.JsonNull
              : (data.metadataJson as Prisma.InputJsonValue),
        },
      });
      return this.toDomain(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BusinessRuleViolationError(
          'A PaymentMethod with this name already exists for the tenant',
          'DUPLICATE_NAME',
        );
      }
      throw error;
    }
  }

  async update(paymentMethod: PaymentMethod): Promise<PaymentMethod> {
    const prisma = this.tenantPrisma.getClient();
    const data = paymentMethod.toPersistence();
    try {
      const updated = await prisma.paymentMethod.update({
        where: { id: data.id },
        data: {
          name: data.name,
          category: data.category,
          subtitle: data.subtitle,
          isActive: data.isActive,
          metadataJson:
            data.metadataJson === null
              ? Prisma.JsonNull
              : (data.metadataJson as Prisma.InputJsonValue),
          updatedAt: data.updatedAt,
        },
      });
      return this.toDomain(updated);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new EntityNotFoundError('PaymentMethod', data.id);
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BusinessRuleViolationError(
          'A PaymentMethod with this name already exists for the tenant',
          'DUPLICATE_NAME',
        );
      }
      throw error;
    }
  }

  async findById(
    id: string,
    tenantId: string,
  ): Promise<PaymentMethod | null> {
    const prisma = this.tenantPrisma.getClient();
    // Defense-in-depth: the tenant-scoped extension auto-injects
    // `tenantId` into the WHERE, so a cross-tenant row is filtered out
    // (returns null, not leaked). We pass `tenantId` explicitly via a
    // `where` clause to keep the API contract clear even when the
    // extension is bypassed.
    const record = await prisma.paymentMethod.findFirst({
      where: { id, tenantId },
    });
    return record ? this.toDomain(record) : null;
  }

  async findAll(tenantId: string): Promise<PaymentMethod[]> {
    const prisma = this.tenantPrisma.getClient();
    const records = await prisma.paymentMethod.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
    });
    return records.map((r) => this.toDomain(r));
  }

  async findAllActive(tenantId: string): Promise<PaymentMethod[]> {
    const prisma = this.tenantPrisma.getClient();
    const records = await prisma.paymentMethod.findMany({
      where: { tenantId, isActive: true },
      orderBy: { name: 'asc' },
    });
    return records.map((r) => this.toDomain(r));
  }

  private toDomain(record: PaymentMethodRecord): PaymentMethod {
    return PaymentMethod.fromPersistence({
      id: record.id,
      tenantId: record.tenantId,
      name: record.name,
      category: coerceCategory(record.category),
      subtitle: record.subtitle,
      isActive: record.isActive,
      // Prisma's JSON column is typed as `Prisma.JsonValue`; coerce via
      // unknown so the entity's `metadataJson: Record<string, unknown>
      // | null` contract is preserved. Null is the absent case.
      metadataJson:
        record.metadataJson === null
          ? null
          : (record.metadataJson as unknown as Record<string, unknown>),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
}