/**
 * shipping-zones / T3 (S8) — Prisma adapter for persisted shipping quotes.
 * Base client with an explicit `tenantId` in every WHERE, so it also works
 * outside a request CLS scope (the later checkout runs inside one anyway).
 * Rows are insert-only; nothing here updates or deletes a quote.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, ShippingQuote } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type {
  IShippingQuoteRepository,
  NewShippingQuote,
  PricedQuoteLine,
  QuoteBoxSnapshot,
  QuoteCarrierOption,
  QuoteDestinationSnapshot,
  QuoteZoneSnapshot,
  StoredShippingQuote,
} from '../domain/shipping-quote.repository';

type JsonOption = Omit<QuoteCarrierOption, 'validUntil'> & {
  validUntil: string | null;
};

const json = (value: unknown): Prisma.InputJsonValue =>
  // SAFETY: a JSON round trip of a plain object yields a JSON value (Dates
  // become ISO strings, which `toStored` turns back into Dates).
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/**
 * Reads back a JSON column as the shape `create` wrote into it.
 */
function readJson<T>(value: Prisma.JsonValue): T {
  // SAFETY: shipping_quotes JSON columns are written only by `create` below,
  // from the typed `NewShippingQuote` fields they are read back as.
  return value as unknown as T;
}

function toStored(row: ShippingQuote): StoredShippingQuote {
  const destination = readJson<QuoteDestinationSnapshot>(row.destination);
  const zone = readJson<QuoteZoneSnapshot & { option?: JsonOption | null }>(
    row.zone,
  );
  const { option: rawOption, ...zoneSnapshot } = zone;
  const option: QuoteCarrierOption | null = rawOption
    ? {
        ...rawOption,
        validUntil: rawOption.validUntil
          ? new Date(rawOption.validUntil)
          : null,
      }
    : null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    customerId: row.customerId,
    phoneCountryCode: row.phoneCountryCode,
    phone: row.phone,
    lines: readJson<PricedQuoteLine[]>(row.lines).map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
    })),
    destination: {
      zipCode: destination.zipCode,
      state: destination.state,
      municipality: destination.municipality,
      neighborhood: destination.neighborhood,
    },
    zone: zoneSnapshot,
    option,
    box: row.box === null ? null : readJson<QuoteBoxSnapshot>(row.box),
    etaDays: row.etaDays,
    etaReason: row.etaReason === 'STOCK_PENDING' ? 'STOCK_PENDING' : null,
    costCents: row.costCents,
    creditCents: row.creditCents,
    customerChargeCents: row.customerChargeCents,
    currency: row.currency,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaShippingQuoteRepository implements IShippingQuoteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(quote: NewShippingQuote): Promise<string> {
    const row = await this.prisma.shippingQuote.create({
      data: {
        tenantId: quote.tenantId,
        tokenHash: quote.tokenHash,
        customerId: quote.customerId,
        phoneCountryCode: quote.phoneCountryCode,
        phone: quote.phone,
        lines: json(quote.lines),
        destination: json(quote.destination),
        shippingAddressId: quote.destination.shippingAddressId,
        zoneType: quote.zone.type,
        // The chosen carrier option (incl. its validity) rides with the zone
        // snapshot; its searchable parts are columns.
        zone: json({ ...quote.zone, option: quote.option }),
        carrier: quote.option?.carrier ?? null,
        service: quote.option?.service ?? null,
        carrierRateId: quote.option?.rateId ?? null,
        etaDays: quote.etaDays,
        etaReason: quote.etaReason,
        box: quote.box ? json(quote.box) : undefined,
        costCents: quote.costCents,
        creditCents: quote.creditCents,
        customerChargeCents: quote.customerChargeCents,
        currency: 'MXN',
        expiresAt: quote.expiresAt,
        createdAt: quote.createdAt,
      },
      select: { id: true },
    });
    return row.id;
  }

  async findByTokenHash(
    tenantId: string,
    tokenHash: string,
  ): Promise<StoredShippingQuote | null> {
    const row = await this.prisma.shippingQuote.findFirst({
      where: { tenantId, tokenHash },
    });
    return row ? toStored(row) : null;
  }
}
