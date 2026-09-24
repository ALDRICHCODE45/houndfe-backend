/**
 * ADAPTER: PrismaSaleDeliverySummaryRepository — delivery-routes / DTE-2.
 *
 * Concrete implementation of `ISaleDeliverySummaryReader`: the persisted
 * confirmed+delivered sale snapshot a future customer thank-you email
 * renders. It uses the global `PrismaService` (not
 * `TenantPrismaService`) so the port can be invoked OUTSIDE the HTTP CLS
 * context — the Inngest handler's
 * `tenantRunner.runWithTenant(tenantId, ...)` opens a fresh scope inside
 * the step callback, so we trust the explicit `tenantId` argument and
 * keep `where: { id, tenantId }` for defense in depth.
 *
 * Tenant scoping — CRITICAL.
 *
 * The top-level `where` is `{ id, tenantId, status: 'CONFIRMED',
 * deliveryStatus: 'DELIVERED' }`, so an absent, foreign, cancelled or
 * undelivered sale resolves to `null` before any projection is built.
 *
 * The nested relation is a separate hazard. Prisma CAN tenant-filter a
 * to-many projection (a nested `items: { where: { tenantId } }`), but
 * that filter silently OMITS a cross-tenant line and hands back the
 * remaining rows as if the sale were complete — an incomplete summary
 * the email would then present as truthful. This adapter therefore
 * selects ALL persisted lines (no nested `where`) and validates every
 * line's `tenantId` after the read; a single foreign line fails the
 * whole read closed to `null`, and a zero-line result also fails closed.
 *
 * `Sale.customerId` keys on a bare customer id too, so a tenant-owned
 * sale can carry a foreign customer id. The customer select asks for
 * `tenantId` beside the name fields; a mismatch only SUPPRESSES the
 * name (the summary still resolves), because the caller still needs to
 * reach the separate authoritative email lookup to skip the send
 * without cross-tenant disclosure.
 *
 * Money semantics — persisted, never recomputed.
 *
 * `subtotalCents` / `discountCents` / `totalCents` are the persisted
 * `Sale` columns, passed through verbatim. Per line, `unitPriceCents` is
 * the persisted price and `lineTotalCents` mirrors the confirmed-sale
 * receipt convention (`unitPriceCents * quantity - rewardCents`), where
 * `rewardCents` is the persisted `discountAmountCents` of a
 * promotion-reward line only (`isBxgy` shape: `promotionId` set,
 * `prePriceCentsBeforeDiscount` present, `unitPriceCents ===
 * prePriceCentsBeforeDiscount`, positive `discountAmountCents`). On a
 * free-form / coupon row the unit price is already NET, so subtracting
 * `discountAmountCents` again would double count — it stays
 * informational and `lineTotalCents` is the only rendered line total.
 *
 * The customer email is deliberately NOT selected: the authoritative
 * recipient address is resolved separately and at send time through
 * `ISaleCustomerEmailLookup`.
 *
 * No catalog or promotion is re-read: the projection is entirely built
 * from persisted `Sale` / `SaleItem` snapshots.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type {
  ISaleDeliverySummaryReader,
  SaleDeliverySummary,
  SaleDeliverySummaryItem,
} from '../domain/ports/sale-delivery-summary.port';

/** Persisted `SaleItem.rewardKind` column shape (nullable on old rows). */
type PersistedRewardKind = 'BUY_X_GET_Y' | 'ADVANCED' | null;

/** The subset of the persisted item row this projection reads. */
type ProjectedSaleItem = {
  tenantId: string;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPriceCents: number;
  discountAmountCents: number | null;
  discountTitle: string | null;
  prePriceCentsBeforeDiscount: number | null;
  promotionId: string | null;
  rewardKind: PersistedRewardKind;
};

/**
 * Column-derived reward shape, identical to the confirmed-sale receipt
 * mapper: a reward line keeps the GROSS unit price in
 * `unitPriceCents` and stores the reward in `discountAmountCents`, so
 * the reward must be nested off the gross line total to render NET.
 * Every other line (including coupon / free-form) is already NET.
 */
function isRewardLine(item: ProjectedSaleItem): boolean {
  return (
    item.promotionId != null &&
    item.prePriceCentsBeforeDiscount != null &&
    item.unitPriceCents === item.prePriceCentsBeforeDiscount &&
    (item.discountAmountCents ?? 0) > 0
  );
}

/** Map the persisted reward column to the wire discriminator. */
function toWireRewardKind(
  rewardKind: PersistedRewardKind,
): 'buy_x_get_y' | 'advanced' | null {
  if (rewardKind === 'BUY_X_GET_Y') return 'buy_x_get_y';
  if (rewardKind === 'ADVANCED') return 'advanced';
  return null;
}

function mapItem(item: ProjectedSaleItem): SaleDeliverySummaryItem {
  const rewardLine = isRewardLine(item);
  const discountAmountCents = item.discountAmountCents ?? null;
  const rewardCents = rewardLine ? (discountAmountCents ?? 0) : 0;
  // Persisted column wins and is surfaced VERBATIM — parity with the
  // confirmed-sale mapper in `prisma-sale.repository.ts`. A non-null
  // kind therefore does NOT prove a positive discount (a row can persist
  // `rewardKind` with `discountAmountCents === 0`); only `lineTotalCents`
  // reflects whether a reward was actually netted. The column-derived
  // shape is the back-compat fallback for pre-migration rows whose
  // column is null.
  const rewardKind =
    toWireRewardKind(item.rewardKind) ?? (rewardLine ? 'buy_x_get_y' : null);
  return {
    productName: item.productName,
    variantName: item.variantName ?? null,
    quantity: item.quantity,
    unitPriceCents: item.unitPriceCents,
    lineTotalCents: item.unitPriceCents * item.quantity - rewardCents,
    discountAmountCents,
    discountTitle: item.discountTitle ?? null,
    rewardKind,
  };
}

/**
 * Compose the customer display name, but ONLY after re-checking the
 * child customer's tenant identity. A foreign customer, a null
 * relation, or a blank persisted first name yields `null` — never a
 * foreign name.
 */
function mapCustomerName(
  customer: {
    tenantId: string;
    firstName: string;
    lastName: string | null;
  } | null,
  tenantId: string,
): string | null {
  if (!customer || customer.tenantId !== tenantId) return null;
  if (typeof customer.firstName !== 'string') return null;
  const firstName = customer.firstName.trim();
  if (firstName.length === 0) return null;
  const lastName =
    typeof customer.lastName === 'string' ? customer.lastName.trim() : '';
  return lastName.length > 0 ? `${firstName} ${lastName}` : firstName;
}

@Injectable()
export class PrismaSaleDeliverySummaryRepository implements ISaleDeliverySummaryReader {
  constructor(private readonly prisma: PrismaService) {}

  async findConfirmedDeliveredSummary(input: {
    tenantId: string;
    saleId: string;
  }): Promise<SaleDeliverySummary | null> {
    if (!input.tenantId || !input.saleId) {
      return null;
    }

    const row = await this.prisma.sale.findFirst({
      where: {
        id: input.saleId,
        tenantId: input.tenantId,
        status: 'CONFIRMED',
        deliveryStatus: 'DELIVERED',
      },
      select: {
        id: true,
        folio: true,
        confirmedAt: true,
        subtotalCents: true,
        discountCents: true,
        totalCents: true,
        customer: {
          select: { tenantId: true, firstName: true, lastName: true },
        },
        items: {
          select: {
            tenantId: true,
            productName: true,
            variantName: true,
            quantity: true,
            unitPriceCents: true,
            discountAmountCents: true,
            discountTitle: true,
            prePriceCentsBeforeDiscount: true,
            promotionId: true,
            rewardKind: true,
          },
          // Fully deterministic: `createdAt` orders lines as recorded and
          // `id` breaks same-millisecond ties, so two reads of the same
          // sale never reorder the template.
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });

    if (!row) {
      return null;
    }

    // A confirmed+delivered sale with zero lines has nothing truthful to
    // show: fail closed instead of emailing an empty summary.
    if (row.items.length === 0) {
      return null;
    }

    // No nested tenant filter was applied (a nested `where` would silently
    // drop a foreign line and yield an incomplete email), so every line is
    // validated here — a foreign child line fails the whole read closed.
    if (row.items.some((item) => item.tenantId !== input.tenantId)) {
      return null;
    }

    return {
      saleId: row.id,
      folio: row.folio,
      confirmedAt: row.confirmedAt,
      currency: 'MXN',
      subtotalCents: row.subtotalCents,
      discountCents: row.discountCents,
      totalCents: row.totalCents,
      customerName: mapCustomerName(row.customer, input.tenantId),
      items: row.items.map(mapItem),
    };
  }
}
