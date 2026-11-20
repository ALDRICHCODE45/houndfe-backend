/**
 * Pure rules of backorder intake (contract v1 §6.1). No I/O: the application
 * service loads the rows and these functions decide, so every rule is unit
 * tested without a database.
 */
import { createHash } from 'node:crypto';
import { BackorderError } from './backorder-error';

const DAY_MS = 86_400_000;

/** What the intake needs from the decision row (a `human_decisions` projection). */
export interface RestockDecisionView {
  type: string;
  status: string;
  resolutionAction: string | null;
  restockDays: number | null;
  resolvedAt: Date | null;
  productId: string;
  variantId: string | null;
}

export interface BackorderTarget {
  productId: string;
  variantId: string | null;
}

export interface RestockEstimate {
  estimatedArrivalDays: number;
  estimatedAt: Date;
}

/**
 * `sourceDecisionId` must be a RESTOCK decision of this tenant, for the same
 * product and variant, answered `PROVIDE_RESTOCK_ESTIMATE`:
 *
 * - missing, another type, or another product/variant → `SOURCE_DECISION_NOT_FOUND`
 *   (the caller loads it with the tenant filter, so another sucursal's
 *   decision is also "missing");
 * - found but pending, or answered "estimate unavailable" →
 *   `SOURCE_DECISION_NOT_ESTIMATED`.
 *
 * `estimatedAt = resolvedAt + restockDays`. A decision may back several
 * backorders over time (rescheduling), and `estimatedAt` may already be past:
 * the backorder then starts with `etaStage = 0` and T4 requests the re-estimate.
 */
export function resolveRestockEstimate(
  decision: RestockDecisionView | null,
  target: BackorderTarget,
): RestockEstimate {
  if (
    !decision ||
    decision.type !== 'RESTOCK' ||
    decision.productId !== target.productId ||
    (decision.variantId ?? null) !== (target.variantId ?? null)
  ) {
    throw new BackorderError('SOURCE_DECISION_NOT_FOUND');
  }
  if (
    decision.status !== 'RESOLVED' ||
    decision.resolutionAction !== 'PROVIDE_RESTOCK_ESTIMATE' ||
    decision.restockDays === null ||
    decision.resolvedAt === null
  ) {
    throw new BackorderError('SOURCE_DECISION_NOT_ESTIMATED');
  }
  return {
    estimatedArrivalDays: decision.restockDays,
    estimatedAt: new Date(
      decision.resolvedAt.getTime() + decision.restockDays * DAY_MS,
    ),
  };
}

export interface VariantSelectionInput {
  productHasVariants: boolean;
  variantId: string | null;
  /** The variant row found with the tenant filter, when `variantId` was sent. */
  variant: { id: string; productId: string } | null;
  productId: string;
}

/**
 * `variantId` is required when the product has variants (`VARIANT_REQUIRED`),
 * must exist (`VARIANT_NOT_FOUND`) and must belong to the product
 * (`VARIANT_NOT_OF_PRODUCT`). A product without variants takes no variant.
 */
export function assertVariantSelection(input: VariantSelectionInput): void {
  if (input.variantId === null) {
    if (input.productHasVariants) throw new BackorderError('VARIANT_REQUIRED');
    return;
  }
  if (!input.variant) throw new BackorderError('VARIANT_NOT_FOUND');
  if (
    !input.productHasVariants ||
    input.variant.productId !== input.productId
  ) {
    throw new BackorderError('VARIANT_NOT_OF_PRODUCT');
  }
}

/**
 * A backorder exists only for stock that cannot cover the request. When the
 * sellable stock (the same figure the bot catalog reports) already covers
 * `quantity`, or the product does not track stock (`sellable === null`, always
 * sellable), the customer buys normally: `STOCK_AVAILABLE_NOW`.
 */
export function assertStockShortfall(input: {
  sellable: number | null;
  quantity: number;
}): void {
  if (input.sellable === null || input.sellable >= input.quantity) {
    throw new BackorderError('STOCK_AVAILABLE_NOW', {
      availableToSell: input.sellable,
    });
  }
}

/**
 * `expectedReferencePriceCents` is optional: when sent and different from the
 * server price the bot quoted a stale price (`PRICE_OUT_OF_DATE`).
 */
export function assertExpectedReferencePrice(
  expected: number | null | undefined,
  currentPriceCents: number,
): void {
  if (
    expected !== null &&
    expected !== undefined &&
    expected !== currentPriceCents
  ) {
    throw new BackorderError('PRICE_OUT_OF_DATE', { currentPriceCents });
  }
}

export interface QueueEntry {
  id: string;
  productId: string;
  variantId: string | null;
  scheduledAt: Date;
}

/** FIFO order of the queue: `scheduledAt`, ties by `id` (§1, §4). */
export function compareQueueOrder(
  a: Pick<QueueEntry, 'id' | 'scheduledAt'>,
  b: Pick<QueueEntry, 'id' | 'scheduledAt'>,
): number {
  const byTime = a.scheduledAt.getTime() - b.scheduledAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 1-based `queuePosition` of every WAITING entry inside its own
 * (product, variant) queue. `waiting` holds the WAITING rows of the involved
 * queues in any order; the position counts only the entries ahead in the same
 * queue.
 */
export function queuePositions(
  waiting: readonly QueueEntry[],
): Map<string, number> {
  const queues = new Map<string, QueueEntry[]>();
  for (const entry of waiting) {
    const key = `${entry.productId}\u0000${entry.variantId ?? ''}`;
    const queue = queues.get(key);
    if (queue) queue.push(entry);
    else queues.set(key, [entry]);
  }
  const positions = new Map<string, number>();
  for (const queue of queues.values()) {
    queue.sort(compareQueueOrder);
    queue.forEach((entry, index) => positions.set(entry.id, index + 1));
  }
  return positions;
}

export interface BackorderIntent {
  phoneCountryCode: string;
  phone: string;
  customer:
    | { mode: 'existing'; customerId: string }
    | { mode: 'createIfAbsent'; firstName: string; lastName?: string | null };
  productId: string;
  variantId?: string | null;
  quantity: number;
  expectedReferencePriceCents?: number | null;
  sourceDecisionId: string;
  chatbotRequestId?: string | null;
}

/**
 * Hash of the full intent behind an `X-Idempotency-Key`: same key + same hash
 * replays, same key + different hash is `IDEMPOTENCY_KEY_CONFLICT`. Omitted and
 * `null` optional members hash the same, so a retry that spells the absence
 * differently still replays.
 */
export function computeBackorderRequestHash(intent: BackorderIntent): string {
  const customer =
    intent.customer.mode === 'existing'
      ? { mode: 'existing', customerId: intent.customer.customerId }
      : {
          mode: 'createIfAbsent',
          firstName: intent.customer.firstName,
          lastName: intent.customer.lastName ?? null,
        };
  return createHash('sha256')
    .update(
      JSON.stringify({
        phoneCountryCode: intent.phoneCountryCode,
        phone: intent.phone,
        customer,
        productId: intent.productId,
        variantId: intent.variantId ?? null,
        quantity: intent.quantity,
        expectedReferencePriceCents: intent.expectedReferencePriceCents ?? null,
        sourceDecisionId: intent.sourceDecisionId,
        chatbotRequestId: intent.chatbotRequestId ?? null,
      }),
    )
    .digest('hex');
}
