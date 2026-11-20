import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { BackorderError } from '../domain/backorder-error';
import type { BackorderIntent } from '../domain/backorder-rules';

type TenantClient = ReturnType<TenantPrismaService['getClient']>;

export type ResolvedBackorderCustomer =
  | {
      kind: 'existing';
      customer: {
        id: string;
        firstName: string;
        globalPriceListId: string | null;
      };
    }
  | { kind: 'new'; firstName: string; lastName: string | null };

/**
 * Customer resolution of the backorder intake (contract v1 §2): the same
 * `existing` / `createIfAbsent` rules and the same phone lookup as checkout
 * (`CheckoutService.create`), without an address.
 *
 * It takes checkout's phone advisory lock (same namespace and key), so a
 * backorder `createIfAbsent` and a checkout `createIfAbsent` for the same phone
 * serialize on the zero-row lookup and cannot both create the customer
 * (`CUSTOMER_PHONE_AMBIGUOUS` afterwards). Must run inside the intake
 * transaction. The new customer is created only after every other validation
 * passed (`createCustomer`), so a rejected request leaves no customer behind
 * even without the rollback.
 */
@Injectable()
export class BackorderCustomerResolver {
  async resolve(
    tx: TenantClient,
    tenantId: string,
    intent: Pick<BackorderIntent, 'phoneCountryCode' | 'phone' | 'customer'>,
  ): Promise<ResolvedBackorderCustomer> {
    const phoneLock = JSON.stringify([
      'bot_checkout_phone',
      tenantId,
      intent.phoneCountryCode,
      intent.phone,
    ]);
    await tx.$queryRaw(
      // pg_advisory_xact_lock returns void; cast only its result to a supported scalar.
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${phoneLock}, 0))::text`,
    );
    const matches = await tx.customer.findMany({
      where: {
        tenantId,
        phoneCountryCode: intent.phoneCountryCode,
        phone: intent.phone,
      },
      select: { id: true, firstName: true, globalPriceListId: true },
      take: 2,
    });
    if (matches.length > 1)
      throw new BackorderError('CUSTOMER_PHONE_AMBIGUOUS');
    const customer = matches[0];
    if (intent.customer.mode === 'existing') {
      if (!customer || customer.id !== intent.customer.customerId) {
        throw new BackorderError('CUSTOMER_NOT_FOUND');
      }
      return { kind: 'existing', customer };
    }
    if (customer) return { kind: 'existing', customer };
    return {
      kind: 'new',
      firstName: intent.customer.firstName,
      lastName: intent.customer.lastName ?? null,
    };
  }

  async createCustomer(
    tx: TenantClient,
    tenantId: string,
    intent: Pick<BackorderIntent, 'phoneCountryCode' | 'phone'>,
    resolved: Extract<ResolvedBackorderCustomer, { kind: 'new' }>,
  ): Promise<{ id: string }> {
    return tx.customer.create({
      data: {
        tenantId,
        phoneCountryCode: intent.phoneCountryCode,
        phone: intent.phone,
        firstName: resolved.firstName,
        lastName: resolved.lastName,
      },
      select: { id: true },
    });
  }
}
