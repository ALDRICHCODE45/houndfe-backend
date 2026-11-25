/**
 * sales-history-redesign S11 (contract §8 + owner 2026-11-25) — customer
 * statement PDF: `GET /customers/:customerId/statement/pdf?from=&to=`.
 *
 * `from`/`to` are LOCAL calendar dates in the business timezone
 * (`PROMOTIONS_BUSINESS_TIMEZONE`, default America/Mexico_City), half-open
 * `[from, to)`, at most 366 days — the same rules as the seller report query,
 * in a dedicated DTO. Bounds stay `YYYY-MM-DD` strings: `new Date('YYYY-MM-DD')`
 * is UTC midnight, never local midnight.
 */
import {
  IsString,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

export const MAX_CUSTOMER_STATEMENT_RANGE_DAYS = 366;

const DAY_MS = 86_400_000;

/** UTC epoch of an exact, real `YYYY-MM-DD` day (year ≥ 1), else null. */
function calendarDayEpoch(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  if (value.startsWith('0000')) return null;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  // `Date.parse` rolls 2026-02-30 over to March; the round trip rejects it.
  if (
    Number.isNaN(epoch) ||
    new Date(epoch).toISOString().slice(0, 10) !== value
  ) {
    return null;
  }
  return epoch;
}

@ValidatorConstraint({ name: 'statementLocalDate', async: false })
class StatementLocalDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return calendarDayEpoch(value) !== null;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be an exact YYYY-MM-DD local calendar date`;
  }
}

/** `from < to <= from + 366 days`; silent while a bound is invalid. */
@ValidatorConstraint({ name: 'statementLocalRange', async: false })
class StatementLocalRangeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const from = calendarDayEpoch((args.object as { from?: unknown }).from);
    const to = calendarDayEpoch(value);
    if (from === null || to === null) return true;
    const days = (to - from) / DAY_MS;
    return days >= 1 && days <= MAX_CUSTOMER_STATEMENT_RANGE_DAYS;
  }

  defaultMessage(): string {
    return `to must be after from and at most ${MAX_CUSTOMER_STATEMENT_RANGE_DAYS} days later (range is half-open [from, to))`;
  }
}

export class CustomerStatementQueryDto {
  /** Inclusive local start date (YYYY-MM-DD). */
  @IsString()
  @Validate(StatementLocalDateConstraint)
  from!: string;

  /** Exclusive local end date (YYYY-MM-DD). */
  @IsString()
  @Validate(StatementLocalDateConstraint)
  @Validate(StatementLocalRangeConstraint)
  to!: string;
}

/** POS payment status of a confirmed sale («Pagada / Impaga / Deuda»). */
export type CustomerStatementPaymentStatus = 'PAID' | 'PARTIAL' | 'CREDIT';

export interface CustomerStatementCustomerDto {
  id: string;
  /** `firstName lastName` (or `firstName`). */
  name: string;
  /** `+<country code> <phone>` or the bare phone; null when absent. */
  phone: string | null;
  email: string | null;
  rfc: string | null;
  businessName: string | null;
}

/** One CONFIRMED sale of the customer with `confirmedAt` in `[from, to)`. */
export interface CustomerStatementSaleDto {
  id: string;
  folio: string | null;
  confirmedAt: string;
  /** Local confirmation day `YYYY-MM-DD` in `timeZone`. */
  localDate: string;
  totalCents: number;
  paidCents: number;
  /** Current open debt of the sale (`openDebtCents`). */
  openDebtCents: number;
  /** Due day: UTC calendar date of `dueDate` (the date the POS shows). */
  dueDate: string | null;
  paymentStatus: CustomerStatementPaymentStatus | null;
  paymentStatusLabel: string;
  /** S3 rule: due day before the local today and open debt > 0. */
  overdue: boolean;
}

/** One payment row of the customer's sales received in `[from, to)`. */
export interface CustomerStatementPaymentDto {
  id: string;
  /** `SalePayment.createdAt` (the receipts print it as the payment time). */
  paidAt: string;
  localDate: string;
  method: string;
  /** Catalog name snapshot when present, else the base method label. */
  methodLabel: string;
  /** Amount kept: tendered minus the change returned at the charge. */
  amountCents: number;
  /** Stored payment amount (what the customer handed over). */
  tenderedCents: number;
  /** Change returned from this cash payment (0 for non-cash). */
  changeCents: number;
  saleId: string;
  saleFolio: string | null;
  /** The sale was canceled later; the money stays listed as received. */
  saleCanceled: boolean;
}

export interface CustomerStatementTotalsDto {
  saleCount: number;
  totalCents: number;
  paidCents: number;
  openDebtCents: number;
  overdueSaleCount: number;
  overdueDebtCents: number;
}

export interface CustomerStatementDebtDto {
  saleCount: number;
  openDebtCents: number;
  overdueSaleCount: number;
  overdueDebtCents: number;
}

export interface CustomerStatementDto {
  timeZone: string;
  from: string;
  to: string;
  /** Local today used by the overdue rule. */
  today: string;
  generatedAt: string;
  branchName: string;
  customer: CustomerStatementCustomerDto;
  /** Ordered by `confirmedAt`, then id. */
  sales: CustomerStatementSaleDto[];
  periodTotals: CustomerStatementTotalsDto;
  /** Every CONFIRMED sale with open debt, also older than the period. */
  currentDebt: CustomerStatementDebtDto;
  /** Ordered by payment time, then id. */
  payments: CustomerStatementPaymentDto[];
  paymentsTotalCents: number;
}
