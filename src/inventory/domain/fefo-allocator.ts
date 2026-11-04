import { InsufficientStockError } from './stock-journal.errors';

export interface FefoLotInput {
  id: string;
  quantity: number;
  expirationDate: Date;
}

/** `lotId: null` is the untracked portion of the product. */
export interface FefoAllocation {
  lotId: string | null;
  quantity: number;
}

/** Calendar date (`YYYY-MM-DD`) of `now` in the business timezone. */
export function businessToday(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * A lot is expired when its expiration calendar date is before `today`.
 * Expiration dates are stored as date-only values at 00:00Z, so the UTC date
 * of the stored instant is the calendar date.
 */
export function isLotExpired(expirationDate: Date, today: string): boolean {
  return expirationDate.toISOString().slice(0, 10) < today;
}

/**
 * FEFO split for one sale line (S6): non-expired lots by expiration asc then id
 * asc, remainder from the untracked portion. Throws when they cannot cover it.
 */
export function allocateFefo(input: {
  quantity: number;
  untrackedAvailable: number;
  lots: FefoLotInput[];
  today: string;
}): FefoAllocation[] {
  const { quantity, untrackedAvailable, lots, today } = input;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError('FEFO quantity must be a positive integer');
  }

  const sellable = lots
    .filter((l) => l.quantity > 0 && !isLotExpired(l.expirationDate, today))
    .sort(
      (a, b) =>
        a.expirationDate.getTime() - b.expirationDate.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  const allocations: FefoAllocation[] = [];
  let remaining = quantity;
  for (const l of sellable) {
    if (remaining === 0) break;
    const take = Math.min(l.quantity, remaining);
    allocations.push({ lotId: l.id, quantity: take });
    remaining -= take;
  }
  if (remaining > 0) {
    if (untrackedAvailable < remaining) {
      const sellableTotal =
        sellable.reduce((sum, l) => sum + l.quantity, 0) +
        Math.max(untrackedAvailable, 0);
      throw new InsufficientStockError(
        'PRODUCT',
        'sellable',
        sellableTotal,
        quantity,
      );
    }
    allocations.push({ lotId: null, quantity: remaining });
  }
  return allocations;
}
