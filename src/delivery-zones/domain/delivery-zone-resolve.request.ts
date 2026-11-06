/**
 * shipping-zones / T1 (S1, S2) — exact parser for the store resolve body.
 *
 * Closed discriminated union, unknown keys rejected:
 *   { expectedVersion, resolutionRequestId, action: 'APPROVE_DELIVERY_ZONE',
 *     zoneType: 'FREE'|'SURCHARGE'|'CARRIER_ONLY', surchargeCents?, etaDays? }
 *   { expectedVersion, resolutionRequestId, action: 'REJECT_DELIVERY_ZONE' }
 * APPROVE re-uses the zone-shape policy; REJECT always settles DENIED.
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  normalizeZoneSettings,
  type ZoneSettings,
} from './delivery-zone.policy';
import {
  APPROVE_DELIVERY_ZONE,
  REJECT_DELIVERY_ZONE,
} from './delivery-zone-validation.repository';

export const INVALID_DELIVERY_ZONE_RESOLVE_CODE =
  'INVALID_DELIVERY_ZONE_RESOLVE_REQUEST';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const APPROVE_KEYS = [
  'expectedVersion',
  'resolutionRequestId',
  'action',
  'zoneType',
  'surchargeCents',
  'etaDays',
];
const REJECT_KEYS = ['expectedVersion', 'resolutionRequestId', 'action'];

interface ResolveRequestBase {
  expectedVersion: number;
  resolutionRequestId: string;
}

export type DeliveryZoneResolveRequest =
  | (ResolveRequestBase & {
      action: typeof APPROVE_DELIVERY_ZONE;
      settings: ZoneSettings & { type: 'FREE' | 'SURCHARGE' | 'CARRIER_ONLY' };
    })
  | (ResolveRequestBase & { action: typeof REJECT_DELIVERY_ZONE });

function fail(): never {
  throw new InvalidArgumentError(
    'Invalid delivery zone resolve request',
    INVALID_DELIVERY_ZONE_RESOLVE_CODE,
  );
}

function fields(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail();
  }
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor =
      typeof key === 'string'
        ? Object.getOwnPropertyDescriptor(value, key)
        : undefined;
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true
    ) {
      fail();
    }
    out[key] = descriptor.value;
  }
  return out;
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number') {
    fail();
  }
  return value;
}

export function parseDeliveryZoneResolveRequest(
  raw: unknown,
): DeliveryZoneResolveRequest {
  const body = fields(raw);
  const allowed =
    body.action === APPROVE_DELIVERY_ZONE
      ? APPROVE_KEYS
      : body.action === REJECT_DELIVERY_ZONE
        ? REJECT_KEYS
        : fail();
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    fail();
  }
  const expectedVersion = body.expectedVersion;
  if (
    typeof expectedVersion !== 'number' ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    fail();
  }
  const resolutionRequestId = body.resolutionRequestId;
  if (
    typeof resolutionRequestId !== 'string' ||
    !UUID_PATTERN.test(resolutionRequestId)
  ) {
    fail();
  }
  if (body.action === REJECT_DELIVERY_ZONE) {
    return {
      expectedVersion,
      resolutionRequestId,
      action: REJECT_DELIVERY_ZONE,
    };
  }
  const zoneType = body.zoneType;
  if (
    zoneType !== 'FREE' &&
    zoneType !== 'SURCHARGE' &&
    zoneType !== 'CARRIER_ONLY'
  ) {
    fail();
  }
  const settings = normalizeZoneSettings({
    type: zoneType,
    surchargeCents: optionalNumber(body.surchargeCents),
    etaDays: optionalNumber(body.etaDays),
  });
  return {
    expectedVersion,
    resolutionRequestId,
    action: APPROVE_DELIVERY_ZONE,
    settings: { ...settings, type: zoneType },
  };
}
