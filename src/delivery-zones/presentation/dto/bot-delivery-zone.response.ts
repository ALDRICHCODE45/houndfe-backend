/**
 * shipping-zones / T1 (S2) — bot projection of one DELIVERY_ZONE requester,
 * served by the intake (`POST /chatbot-api/human-decisions`, 201 created /
 * 200 replay) and the poll (`GET /chatbot-api/human-decisions/:id`).
 *
 * Unlike the RESTOCK receipt, the DELIVERY_ZONE intake returns the CURRENT
 * requester state: a requester may be RESOLVED at intake (`EXISTING_ZONE`).
 * The resolution OMITS `surchargeCents` / `etaDays` when they do not apply
 * (never `null`), mirroring the RESTOCK negative-variant style.
 * `applyBefore = resolvedAt + 24 h` (WhatsApp window). Customer phone,
 * conversation reference, tenant, source, hash and credential never leave.
 */
import type { DeliveryZoneTypeValue } from '../../domain/delivery-zone.policy';
import { CUSTOMER_REPLY_WINDOW_MS } from '../../domain/delivery-zone.policy';
import { DELIVERY_ZONE_TYPE } from '../../domain/delivery-zone-intake.request';
import type {
  DeliveryZoneRequestRecord,
  DeliveryZoneRequestResolutionSourceValue,
} from '../../domain/delivery-zone-bot.repository';

export interface BotDeliveryZoneResolution {
  source: DeliveryZoneRequestResolutionSourceValue;
  zoneType: DeliveryZoneTypeValue;
  surchargeCents?: number;
  etaDays?: number;
  resolvedAt: string;
}

export interface BotDeliveryZoneResponse {
  id: string;
  sourceRequestId: string;
  type: typeof DELIVERY_ZONE_TYPE;
  status: 'PENDING' | 'RESOLVED';
  version: 1 | 2;
  createdAt: string;
  /** The store validation id, or null when answered from an existing zone. */
  decisionId: string | null;
  snapshot: {
    branchName: string | null;
    zipCode: string;
    state: string;
    municipality: string;
    neighborhood: string;
  };
  resolution: BotDeliveryZoneResolution | null;
  applyBefore: string | null;
}

function failClosed(): never {
  throw new Error('Malformed persisted delivery-zone requester state');
}

export function toBotDeliveryZoneResponse(
  record: DeliveryZoneRequestRecord,
): BotDeliveryZoneResponse {
  const common = {
    id: record.id,
    sourceRequestId: record.sourceRequestId,
    type: DELIVERY_ZONE_TYPE,
    createdAt: record.createdAt.toISOString(),
    decisionId: record.validationId,
    snapshot: {
      branchName: record.branchName,
      zipCode: record.zipCode,
      state: record.state,
      municipality: record.municipality,
      neighborhood: record.neighborhood,
    },
  } as const;

  if (record.status === 'PENDING') {
    if (record.version !== 1 || record.resolvedAt !== null) {
      failClosed();
    }
    return {
      ...common,
      status: 'PENDING',
      version: 1,
      resolution: null,
      applyBefore: null,
    };
  }

  const { resolutionSource, zoneType, resolvedAt } = record;
  if (
    record.version !== 2 ||
    resolutionSource === null ||
    zoneType === null ||
    resolvedAt === null
  ) {
    failClosed();
  }
  const resolution: BotDeliveryZoneResolution = {
    source: resolutionSource,
    zoneType,
    ...(record.surchargeCents === null
      ? {}
      : { surchargeCents: record.surchargeCents }),
    ...(record.etaDays === null ? {} : { etaDays: record.etaDays }),
    resolvedAt: resolvedAt.toISOString(),
  };
  return {
    ...common,
    status: 'RESOLVED',
    version: 2,
    resolution,
    applyBefore: new Date(
      resolvedAt.getTime() + CUSTOMER_REPLY_WINDOW_MS,
    ).toISOString(),
  };
}
