/**
 * customer-collection / T3 (S5) — `GET /collections/:id` and the data of the
 * «Cobrar todo» receipt (contract v1 §1, §6, §7; owner Q5 «Un "Comprobante de
 * cobro" general»).
 *
 * Same shape as the POST response, rebuilt from `sale_collections`, its
 * `SalePayment` rows grouped per sale and the stored `tendersJson` (validated
 * on read). Nothing new is persisted; every number describes the COLLECTION
 * MOMENT, so a re-print a week later says what the first print said:
 *
 * - `paidCents` / `debtCents` / `paymentStatus` per sale: the balance right
 *   AFTER the collection — Σ of the sale's payments up to and including this
 *   collection (its own rows + rows created before the collection
 *   transaction), never later payments or refunds. `totalCents` of a
 *   CONFIRMED sale never changes, so debt = total − that sum.
 * - `overdue`: the POST value — the handoff 28 rule over the debt BEFORE the
 *   collection (debt after + applied) with the collection's business-local
 *   day (`createdAt` in `PROMOTIONS_BUSINESS_TIMEZONE`) as "today".
 * - `remainingCustomerDebtCents`: the customer's open debt right after the
 *   collection (same cut); null once the customer was deleted (its sales lose
 *   the customer too, so the other sales can no longer be found).
 * - `saleStatus`: the CURRENT status, so a sale cancelled afterwards reads
 *   `CANCELED` (contract §8: the collection stays as history).
 * - Sales in the Q1 allocation order (= POST order); `paymentIds` per sale in
 *   tender consumption order (non-cash in request order, cash last), ties by
 *   id (two parts of the same method + catalog in one sale).
 *
 * Unknown or foreign-tenant collection → `404 COLLECTION_NOT_FOUND`, the
 * code-only envelope of the customer statement.
 */
import { HttpException, Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { businessToday } from '../inventory/domain/fefo-allocator';
import { isOverdue } from './customer-statement.service';
import {
  orderCollectionCandidates,
  type CollectionTenderMethod,
} from './domain/collection-allocation';
import {
  COLLECTION_READER,
  type CollectionPaymentRecord,
  type CollectionRecord,
  type ICollectionReader,
} from './domain/collection-reader';
import type {
  CollectionCatalogSnapshotDto,
  CollectionReadResponseDto,
  CollectionReadSaleDto,
  CollectionReceiptDto,
  CollectionTenderResponseDto,
} from './dto/customer-collection.dto';

const DEFAULT_BUSINESS_TIMEZONE = 'America/Mexico_City';
const TENDER_METHODS: ReadonlySet<string> = new Set([
  'cash',
  'card_credit',
  'card_debit',
  'transfer',
]);

function notFound(): HttpException {
  return new HttpException(
    {
      statusCode: 404,
      error: 'COLLECTION_NOT_FOUND',
      message: 'COLLECTION_NOT_FOUND',
    },
    404,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCatalog(raw: unknown): CollectionCatalogSnapshotDto | null {
  if (raw === null || raw === undefined) return null;
  if (
    !isRecord(raw) ||
    typeof raw.paymentMethodId !== 'string' ||
    typeof raw.name !== 'string' ||
    (raw.subtitle !== undefined && typeof raw.subtitle !== 'string')
  ) {
    throw new Error('invalid catalog');
  }
  return {
    paymentMethodId: raw.paymentMethodId,
    name: raw.name,
    ...(raw.subtitle !== undefined ? { subtitle: raw.subtitle } : {}),
  };
}

/** The stored tenders, exactly as the POST answered them, or a 500. */
export function parseCollectionTenders(
  raw: unknown,
  tenderedCents: number,
): CollectionTenderResponseDto[] {
  try {
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('not a list');
    const tenders = raw.map((entry: unknown): CollectionTenderResponseDto => {
      if (
        !isRecord(entry) ||
        typeof entry.method !== 'string' ||
        !TENDER_METHODS.has(entry.method) ||
        !Number.isInteger(entry.amountCents) ||
        (entry.amountCents as number) <= 0
      ) {
        throw new Error('invalid tender');
      }
      return {
        method: entry.method as CollectionTenderMethod,
        amountCents: entry.amountCents as number,
        catalog: parseCatalog(entry.catalog),
      };
    });
    const sum = tenders.reduce((total, t) => total + t.amountCents, 0);
    if (sum !== tenderedCents) throw new Error('sum differs');
    return tenders;
  } catch (error) {
    throw new Error(`COLLECTION_TENDERS_INVALID: ${(error as Error).message}`);
  }
}

@Injectable()
export class CollectionReadService {
  constructor(
    @Inject(COLLECTION_READER)
    private readonly reader: ICollectionReader,
    @Optional()
    private readonly config?: ConfigService,
  ) {}

  async getCollection(collectionId: string): Promise<CollectionReadResponseDto> {
    return (await this.getReceipt(collectionId)).collection;
  }

  async getReceipt(collectionId: string): Promise<CollectionReceiptDto> {
    const record = await this.reader.findCollection(collectionId);
    if (!record) throw notFound();
    const payments = parseCollectionTenders(
      record.tendersJson,
      record.tenderedCents,
    );
    return {
      collection: {
        collectionId: record.id,
        customer: record.customer,
        createdAt: record.createdAt.toISOString(),
        tenderedCents: record.tenderedCents,
        appliedCents: record.appliedCents,
        changeDueCents: record.changeDueCents,
        payments,
        sales: this.sales(record, payments),
        remainingCustomerDebtCents: record.customerDebtAfterCents,
      },
      branchName: record.branchName,
      cashierName: record.cashierName,
    };
  }

  private sales(
    record: CollectionRecord,
    tenders: CollectionTenderResponseDto[],
  ): CollectionReadSaleDto[] {
    const today = businessToday(record.createdAt, this.timeZone());
    const rank = this.tenderRank(tenders);
    const shaped = record.sales.map((sale) => {
      const rows = record.payments
        .filter((payment) => payment.saleId === sale.saleId)
        .sort(
          (left, right) =>
            rank(left) - rank(right) ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        );
      const appliedCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
      const paidCents = Math.min(sale.paidThroughCents, sale.totalCents);
      const debtCents = sale.totalCents - paidCents;
      const debtBeforeCents = debtCents + appliedCents;
      const dto: CollectionReadSaleDto = {
        saleId: sale.saleId,
        folio: sale.folio,
        confirmedAt: sale.confirmedAt ? sale.confirmedAt.toISOString() : null,
        dueDate: sale.dueDate ? sale.dueDate.toISOString() : null,
        overdue: isOverdue(sale.dueDate, debtBeforeCents, today),
        appliedCents,
        paidCents,
        debtCents,
        paymentStatus:
          debtCents === 0 ? 'PAID' : paidCents === 0 ? 'CREDIT' : 'PARTIAL',
        paymentIds: rows.map((row) => row.id),
        saleStatus: sale.status === 'CANCELED' ? 'CANCELED' : 'CONFIRMED',
      };
      // Q1 order keys: the debt BEFORE the collection is what was allocated.
      return {
        saleId: sale.saleId,
        dueDate: sale.dueDate,
        confirmedAt: sale.confirmedAt,
        debtCents: debtBeforeCents,
        dto,
      };
    });
    return orderCollectionCandidates(shaped).map((entry) => entry.dto);
  }

  /**
   * Position of a payment row in the tender consumption queue (non-cash in
   * request order, then cash): the first tender with the same method and
   * catalog id.
   */
  private tenderRank(
    tenders: CollectionTenderResponseDto[],
  ): (payment: CollectionPaymentRecord) => number {
    const queue = tenders
      .map((tender, index) => ({ tender, index }))
      .sort(
        (left, right) =>
          Number(left.tender.method === 'cash') -
            Number(right.tender.method === 'cash') || left.index - right.index,
      );
    return (payment) => {
      const method = payment.method.toLowerCase();
      const position = queue.findIndex(
        ({ tender }) =>
          tender.method === method &&
          (tender.catalog?.paymentMethodId ?? null) ===
            payment.catalogPaymentMethodId,
      );
      return position === -1 ? queue.length : position;
    };
  }

  private timeZone(): string {
    return (
      this.config?.get<string>('PROMOTIONS_BUSINESS_TIMEZONE') ??
      DEFAULT_BUSINESS_TIMEZONE
    );
  }
}
