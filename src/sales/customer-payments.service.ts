/**
 * customers-listing T2 (S5, contract §7, §7.1, §7.2) — «Cobros y recibos»:
 * every payment received from a customer, one event per row, newest first.
 *
 * - `collection`: one «Cobrar todo». Tenders through the SAME parser as
 *   `GET /collections/:id` (`parseCollectionTenders`, corrupt JSON → 500),
 *   sales in the same order (`orderCollectionCandidates`), current status.
 * - `payment`: any other `sale_payments` row. `method` lowercase (frontend
 *   L2.3), amount net of change with EXACTLY the statement PDF rule
 *   (`splitSaleChange` over every row of the sale), `receiptPath` null when
 *   the sale is no longer CONFIRMED (the sale PDF answers 400).
 * - Payments of sales canceled later stay listed and flagged; refunds are a
 *   separate ledger and are not read.
 *
 * Unknown or foreign-tenant customer → `404 CUSTOMER_NOT_FOUND`, the
 * code-only envelope of the other customer sales routes.
 */
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { parseCollectionTenders } from './collection-read.service';
import { splitSaleChange } from './customer-statement.service';
import { orderCollectionCandidates } from './domain/collection-allocation';
import {
  CUSTOMER_PAYMENTS_READER,
  type CustomerCollectionEventRecord,
  type CustomerPaymentEventRecord,
  type ICustomerPaymentsReader,
} from './customer-payments.reader';
import type { CollectionCatalogSnapshotDto } from './dto/customer-collection.dto';
import type {
  CustomerCollectionEventDto,
  CustomerPaymentEventDto,
  CustomerPaymentMethod,
  CustomerPaymentsResponseDto,
} from './dto/customer-payments.dto';

function customerNotFound(): HttpException {
  return new HttpException(
    {
      statusCode: 404,
      error: 'CUSTOMER_NOT_FOUND',
      message: 'CUSTOMER_NOT_FOUND',
    },
    404,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `metadataJson.catalog` when it is a valid snapshot, else null (never throws). */
function catalogOf(metadataJson: unknown): CollectionCatalogSnapshotDto | null {
  const catalog = isRecord(metadataJson) ? metadataJson.catalog : undefined;
  if (
    !isRecord(catalog) ||
    typeof catalog.paymentMethodId !== 'string' ||
    typeof catalog.name !== 'string'
  ) {
    return null;
  }
  return {
    paymentMethodId: catalog.paymentMethodId,
    name: catalog.name,
    ...(typeof catalog.subtitle === 'string' && catalog.subtitle.length > 0
      ? { subtitle: catalog.subtitle }
      : {}),
  };
}

@Injectable()
export class CustomerPaymentsService {
  constructor(
    @Inject(CUSTOMER_PAYMENTS_READER)
    private readonly reader: ICustomerPaymentsReader,
  ) {}

  async list(
    customerId: string,
    { page, limit }: { page: number; limit: number },
  ): Promise<CustomerPaymentsResponseDto> {
    const record = await this.reader.read(customerId, {
      offset: (page - 1) * limit,
      limit,
    });
    if (!record) throw customerNotFound();

    return {
      data: record.events.map((event) =>
        event.kind === 'collection'
          ? this.collection(event)
          : this.payment(event),
      ),
      pagination: {
        page,
        limit,
        total: record.total,
        totalPages: record.total === 0 ? 0 : Math.ceil(record.total / limit),
      },
    };
  }

  private collection(
    event: CustomerCollectionEventRecord,
  ): CustomerCollectionEventDto {
    // The order key ignores `debtCents`; it only reads due day, confirmedAt, id.
    const sales = orderCollectionCandidates(
      event.sales.map((sale) => ({ ...sale, debtCents: sale.appliedCents })),
    );
    return {
      kind: 'collection',
      eventId: event.collectionId,
      occurredAt: event.createdAt.toISOString(),
      amountCents: event.appliedCents,
      tenderedCents: event.tenderedCents,
      changeDueCents: event.changeDueCents,
      payments: parseCollectionTenders(event.tendersJson, event.tenderedCents),
      sales: sales.map((sale) => ({
        saleId: sale.saleId,
        folio: sale.folio,
        status: sale.status,
        appliedCents: sale.appliedCents,
      })),
      cashier: event.cashier,
      receiptPath: `/collections/${event.collectionId}/pdf`,
    };
  }

  private payment(event: CustomerPaymentEventRecord): CustomerPaymentEventDto {
    const changes = splitSaleChange(
      event.saleRows.map((row) => ({
        saleId: event.sale.id,
        method: row.method,
        amountCents: row.amountCents,
        saleChangeDueCents: event.sale.changeDueCents,
      })),
    );
    const index = event.saleRows.findIndex((row) => row.id === event.paymentId);
    const changeCents = index === -1 ? 0 : changes[index];
    return {
      kind: 'payment',
      eventId: event.paymentId,
      occurredAt: event.createdAt.toISOString(),
      method: event.method.toLowerCase() as CustomerPaymentMethod,
      catalog: catalogOf(event.metadataJson),
      reference: event.reference,
      amountCents: event.amountCents - changeCents,
      tenderedCents: event.amountCents,
      changeCents,
      sale: {
        id: event.sale.id,
        folio: event.sale.folio,
        status: event.sale.status,
        totalCents: event.sale.totalCents,
      },
      cashier: event.cashier,
      receiptPath:
        event.sale.status === 'CONFIRMED'
          ? `/sales/${event.sale.id}/pdf`
          : null,
    };
  }
}
