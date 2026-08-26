/**
 * ADAPTER: PaymentMethodCatalogResolver — custom-payment-methods / WU2 / D3.
 *
 * Concrete `@Injectable()` implementation of `IPaymentMethodResolver`. A
 * thin read-only orchestrator over `IPaymentMethodRepository`:
 *
 *   - `resolveActive()` validates active + tenant-scoped + category match
 *     and throws the three sales-spec domain codes.
 *   - `listActive()` projects the active rows to the narrow DTO shape
 *     the POS selector needs.
 *
 * The concrete class lives at the admin-module root (not under
 * `infrastructure/`) because it has no Prisma dependency — it composes
 * the existing repository port instead. The admin module exports the
 * `PAYMENT_METHOD_RESOLVER` symbol so SalesModule can `@Inject` without
 * depending on the concrete class.
 */
import { Inject, Injectable } from '@nestjs/common';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import {
  PAYMENT_METHOD_REPOSITORY,
  type IPaymentMethodRepository,
} from './domain/payment-method.repository';
import type {
  IPaymentMethodResolver,
  ResolveActiveInput,
  ResolvedPaymentMethod,
  ActivePaymentMethodProjection,
} from './domain/payment-method.resolver';

@Injectable()
export class PaymentMethodCatalogResolver implements IPaymentMethodResolver {
  constructor(
    @Inject(PAYMENT_METHOD_REPOSITORY)
    private readonly repo: IPaymentMethodRepository,
  ) {}

  async resolveActive(input: ResolveActiveInput): Promise<ResolvedPaymentMethod> {
    const row = await this.repo.findById(input.paymentMethodId, input.tenantId);

    // `findById` returns null on miss OR cross-tenant (the WHERE has both
    // id and tenantId, defense in depth). Surface as the same domain
    // code so the client never distinguishes "missing" from "wrong
    // tenant" — presence-indistinguishable.
    if (!row) {
      throw new BusinessRuleViolationError(
        'PaymentMethod not found or belongs to another tenant',
        'PAYMENT_METHOD_NOT_FOUND',
      );
    }

    if (!row.isActive) {
      throw new BusinessRuleViolationError(
        'PaymentMethod is inactive and cannot be used for new charges',
        'INACTIVE_PAYMENT_METHOD',
      );
    }

    // Case-insensitive compare: the row's `category` is already coerced
    // to lowercase at construction time (sanitizeCategory), so we only
    // need to lowercase the caller's `expectedCategory`.
    const expected = input.expectedCategory.toLowerCase();
    if (row.category !== expected) {
      throw new BusinessRuleViolationError(
        `PaymentMethod category '${row.category}' does not match requested '${expected}'`,
        'PAYMENT_METHOD_CATEGORY_MISMATCH',
      );
    }

    return {
      category: row.category,
      name: row.name,
      subtitle: row.subtitle,
    };
  }

  async listActive(
    tenantId: string,
  ): Promise<ActivePaymentMethodProjection[]> {
    const rows = await this.repo.findAllActive(tenantId);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      subtitle: row.subtitle,
    }));
  }
}