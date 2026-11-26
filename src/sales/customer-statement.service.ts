/**
 * sales-history-redesign S11 (contract §8, owner 2026-11-25) — customer
 * statement data for the A4 PDF.
 *
 * ONE reader call (one RepeatableRead snapshot), then pure shaping here:
 * - overdue uses EXACTLY the S3 rule of `GET /sales` (contract §7): due day =
 *   UTC calendar date of `dueDate` (the date the POS shows), overdue when it
 *   is before today's LOCAL date in the business timezone and the open debt
 *   is > 0 (the reader only returns CONFIRMED sales). Today comes from the
 *   injectable `SALES_CLOCK`;
 * - period totals over the listed sales; current debt over every open-debt
 *   sale of the customer (also older than the period);
 * - payments are only the received `SalePayment` rows. Refund obligations
 *   (`SaleRefund`) and refund installments (`SaleRefundSettlement`) are a
 *   separate ledger and are NOT listed or subtracted. Cash is reported net of
 *   the sale-level change returned at the charge (`changeDueCents`).
 *
 * Unknown or foreign-tenant customer → `404 CUSTOMER_NOT_FOUND`, code-only
 * envelope (the one `GET /customers/:customerId/sales-monthly` answers).
 */
import { HttpException, Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { businessToday } from '../inventory/domain/fefo-allocator';
import { SALES_CLOCK } from './sales.service';
import {
  CUSTOMER_STATEMENT_READER,
  type CustomerStatementSnapshot,
  type ICustomerStatementReader,
} from './domain/customer-statement.reader';
import type {
  CustomerStatementCustomerDto,
  CustomerStatementDebtDto,
  CustomerStatementDto,
  CustomerStatementPaymentDto,
  CustomerStatementSaleDto,
} from './dto/customer-statement.dto';

const DEFAULT_BUSINESS_TIMEZONE = 'America/Mexico_City';

/** POS labels (R10, contract §9.1). */
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PAID: 'Pagada',
  PARTIAL: 'Impaga',
  CREDIT: 'Deuda',
};

/**
 * Base method labels when the payment has no catalog snapshot: the receipt
 * labels (`Efectivo`, `Transferencia`, `Crédito`) plus the card labels of the
 * cash register (`Tarjeta de crédito/débito`). Unknown codes print as-is.
 */
const METHOD_LABELS: Record<string, string> = {
  CASH: 'Efectivo',
  CARD_CREDIT: 'Tarjeta de crédito',
  CARD_DEBIT: 'Tarjeta de débito',
  TRANSFER: 'Transferencia',
  CREDIT: 'Crédito',
};

/** Due day: the UTC calendar date of the stored `dueDate`. */
function dueDay(dueDate: Date | null): string | null {
  return dueDate ? dueDate.toISOString().slice(0, 10) : null;
}

/** S3 overdue rule (contract §7) for a CONFIRMED sale. */
export function isOverdue(
  dueDate: Date | null,
  openDebtCents: number,
  today: string,
): boolean {
  const day = dueDay(dueDate);
  return openDebtCents > 0 && day !== null && day < today;
}

/** One payment row as the change rule needs it. */
export interface SaleChangeRow {
  saleId: string;
  /** DB enum (`CASH`, `CARD_CREDIT`, `CARD_DEBIT`, `TRANSFER`). */
  method: string;
  /** Stored (tendered) amount. */
  amountCents: number;
  /** The sale-level change returned at the charge (`sales.changeDueCents`). */
  saleChangeDueCents: number;
}

/**
 * The statement change rule, shared with the customer payments feed: change
 * is recorded once per sale (`changeDueCents`) and only on a cash charge that
 * settled the sale, so every payment row of such a sale is a charge row; the
 * change is taken from its CASH rows in payment order (rows must come in
 * `createdAt asc, id asc`). Returns the change share of each row, in order.
 */
export function splitSaleChange(rows: readonly SaleChangeRow[]): number[] {
  const changeLeft = new Map<string, number>();
  return rows.map((row) => {
    if (!changeLeft.has(row.saleId)) {
      changeLeft.set(row.saleId, Math.max(row.saleChangeDueCents, 0));
    }
    let changeCents = 0;
    if (row.method === 'CASH') {
      changeCents = Math.min(changeLeft.get(row.saleId)!, row.amountCents);
      changeLeft.set(row.saleId, changeLeft.get(row.saleId)! - changeCents);
    }
    return changeCents;
  });
}

function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

@Injectable()
export class CustomerStatementService {
  constructor(
    @Inject(CUSTOMER_STATEMENT_READER)
    private readonly reader: ICustomerStatementReader,
    @Optional()
    @Inject(SALES_CLOCK)
    private readonly clock?: () => Date,
    @Optional()
    private readonly config?: ConfigService,
  ) {}

  async getStatement(
    customerId: string,
    range: { from: string; to: string },
  ): Promise<CustomerStatementDto> {
    const timeZone =
      this.config?.get<string>('PROMOTIONS_BUSINESS_TIMEZONE') ??
      DEFAULT_BUSINESS_TIMEZONE;
    const now = this.clock ? this.clock() : new Date();
    const today = businessToday(now, timeZone);

    const snapshot = await this.reader.read(customerId, {
      from: range.from,
      to: range.to,
      timeZone,
    });
    if (!snapshot) {
      throw new HttpException(
        {
          statusCode: 404,
          error: 'CUSTOMER_NOT_FOUND',
          message: 'CUSTOMER_NOT_FOUND',
        },
        404,
      );
    }

    const sales = snapshot.periodSales.map(
      (sale): CustomerStatementSaleDto => ({
        id: sale.id,
        folio: sale.folio,
        confirmedAt: sale.confirmedAt.toISOString(),
        localDate: sale.localDate,
        totalCents: sale.totalCents,
        paidCents: sale.paidCents,
        openDebtCents: sale.openDebtCents,
        dueDate: dueDay(sale.dueDate),
        paymentStatus: sale.paymentStatus,
        paymentStatusLabel: sale.paymentStatus
          ? PAYMENT_STATUS_LABELS[sale.paymentStatus]
          : '—',
        overdue: isOverdue(sale.dueDate, sale.openDebtCents, today),
      }),
    );
    const overdueSales = sales.filter((sale) => sale.overdue);
    const payments = this.shapePayments(snapshot.payments);

    return {
      timeZone,
      from: range.from,
      to: range.to,
      today,
      generatedAt: now.toISOString(),
      branchName: snapshot.branchName,
      customer: this.shapeCustomer(snapshot.customer),
      sales,
      periodTotals: {
        saleCount: sales.length,
        totalCents: sum(sales, (s) => s.totalCents),
        paidCents: sum(sales, (s) => s.paidCents),
        openDebtCents: sum(sales, (s) => s.openDebtCents),
        overdueSaleCount: overdueSales.length,
        overdueDebtCents: sum(overdueSales, (s) => s.openDebtCents),
      },
      currentDebt: this.currentDebt(snapshot.openDebtSales, today),
      payments,
      paymentsTotalCents: sum(payments, (p) => p.amountCents),
    };
  }

  private shapeCustomer(
    customer: CustomerStatementSnapshot['customer'],
  ): CustomerStatementCustomerDto {
    const lastName = blankToNull(customer.lastName);
    const phone = blankToNull(customer.phone);
    const code = blankToNull(customer.phoneCountryCode);
    return {
      id: customer.id,
      name: lastName
        ? `${customer.firstName.trim()} ${lastName}`
        : customer.firstName.trim(),
      phone:
        phone && code
          ? `${code.startsWith('+') ? code : `+${code}`} ${phone}`
          : phone,
      email: blankToNull(customer.email),
      rfc: blankToNull(customer.rfc),
      businessName: blankToNull(customer.businessName),
    };
  }

  private currentDebt(
    openDebtSales: CustomerStatementSnapshot['openDebtSales'],
    today: string,
  ): CustomerStatementDebtDto {
    const open = openDebtSales.filter((sale) => sale.openDebtCents > 0);
    const overdue = open.filter((sale) =>
      isOverdue(sale.dueDate, sale.openDebtCents, today),
    );
    return {
      saleCount: open.length,
      openDebtCents: sum(open, (s) => s.openDebtCents),
      overdueSaleCount: overdue.length,
      overdueDebtCents: sum(overdue, (s) => s.openDebtCents),
    };
  }

  /** Cash net of the sale-level change (`splitSaleChange`). */
  private shapePayments(
    rows: CustomerStatementSnapshot['payments'],
  ): CustomerStatementPaymentDto[] {
    const changes = splitSaleChange(rows);
    return rows.map((row, index) => {
      const changeCents = changes[index];
      return {
        id: row.id,
        paidAt: row.paidAt.toISOString(),
        localDate: row.localDate,
        method: row.method,
        methodLabel:
          blankToNull(row.catalogName) ??
          METHOD_LABELS[row.method] ??
          row.method,
        amountCents: row.amountCents - changeCents,
        tenderedCents: row.amountCents,
        changeCents,
        saleId: row.saleId,
        saleFolio: row.saleFolio,
        saleCanceled: row.saleStatus === 'CANCELED',
      };
    });
  }
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
