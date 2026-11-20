/**
 * Pure builders of the staff list query (contract v1 §9.1): the `where` shared
 * by the page, the total and the per-status counts, and the sort.
 *
 * `counts` honour EVERY filter except `status`: the same builder runs with
 * `withStatus: false`.
 */
import type { Prisma } from '@prisma/client';
import type { StaffBackorderListFilter } from '../domain/backorder-staff-query';

/** More words than this are ignored (a free-text box, not a query language). */
const MAX_SEARCH_TOKENS = 5;

export function searchTokens(q: string): string[] {
  return q.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TOKENS);
}

const contains = (value: string) => ({
  contains: value,
  mode: 'insensitive' as const,
});

/**
 * One group per word, every group must match (AND): a word matches the
 * customer's first/last name, the product or the variant name, and a word with
 * digits also the customer's phone (digits only) or country code, so a number
 * typed as `+52 (55) 1234 5678` matches.
 */
function searchGroups(q: string): Prisma.BackorderWhereInput[] {
  return searchTokens(q).map((token) => {
    const digits = token.replace(/\D/g, '');
    return {
      OR: [
        { customer: { firstName: contains(token) } },
        { customer: { lastName: contains(token) } },
        { product: { name: contains(token) } },
        { variant: { name: contains(token) } },
        ...(digits
          ? [
              { customer: { phone: { contains: digits } } },
              { customer: { phoneCountryCode: digits } },
            ]
          : []),
      ],
    };
  });
}

export function staffListWhere(
  tenantId: string,
  filter: StaffBackorderListFilter,
  options: { withStatus: boolean },
): Prisma.BackorderWhereInput {
  return {
    tenantId,
    ...(options.withStatus && filter.statuses?.length
      ? { status: { in: [...filter.statuses] } }
      : {}),
    ...(filter.productId ? { productId: filter.productId } : {}),
    ...(filter.variantId ? { variantId: filter.variantId } : {}),
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(filter.from || filter.to
      ? {
          scheduledAt: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
          },
        }
      : {}),
    ...(filter.q ? { AND: searchGroups(filter.q) } : {}),
  };
}

/**
 * The requested field, then queue order (`scheduledAt`, `id`) so a page never
 * repeats or skips a row. `status` sorts in enum order (WAITING, RESERVED,
 * CONFIRMED, EXPIRED, CANCELLED); a null `reservedUntil` is always last.
 */
export function staffListOrderBy(
  filter: StaffBackorderListFilter,
): Prisma.BackorderOrderByWithRelationInput[] {
  const { sortBy, sortOrder } = filter;
  if (sortBy === 'scheduledAt') {
    return [{ scheduledAt: sortOrder }, { id: 'asc' }];
  }
  const primary: Prisma.BackorderOrderByWithRelationInput =
    sortBy === 'reservedUntil'
      ? { reservedUntil: { sort: sortOrder, nulls: 'last' } }
      : { status: sortOrder };
  return [primary, { scheduledAt: 'asc' }, { id: 'asc' }];
}
