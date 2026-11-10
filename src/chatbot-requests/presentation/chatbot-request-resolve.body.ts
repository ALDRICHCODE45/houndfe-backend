/**
 * Body of `POST /chatbot-requests/:id/resolve` (contract §3.8, §12.6): the
 * flat union the existing parsers accept, with `expectedVersion` of the common
 * request and without `resolutionRequestId`, which the backend derives from
 * the Idempotency-Key. Each family reuses its existing exact parser, so every
 * unknown or missing key is rejected exactly as today (`400`).
 *
 * `customerReason` is required on `REJECT_RECEIPT` here: it is the text the
 * bot sends the customer (the old route only defaults it for compatibility).
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { parseDeliveryZoneResolveRequest } from '../../delivery-zones/domain/delivery-zone-resolve.request';
import {
  APPROVE_DELIVERY_ZONE,
  REJECT_DELIVERY_ZONE,
} from '../../delivery-zones/domain/delivery-zone-validation.repository';
import {
  parseExpirationResolveHumanDecisionRequest,
  parseResolveHumanDecisionRequest,
  RESOLVE_PROVIDE_EXPIRATION_TEXT,
  RESOLVE_PROVIDE_RESTOCK_ESTIMATE,
  RESOLVE_REPORT_EXPIRATION_UNAVAILABLE,
  RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE,
} from '../../human-decisions/presentation/dto/resolve-human-decision.request';
import type { ResolveAction } from '../application/chatbot-request-commands.service';

export interface ParsedResolveBody {
  expectedVersion: number;
  action: ResolveAction;
}

const CUSTOMER_REASON_MAX = 300;
const REASON_MAX = 1000;

const invalid = (): never => {
  throw new InvalidArgumentError('Invalid resolve request', 'VALIDATION_ERROR');
};

/** Own enumerable data properties only: no getters, symbols or prototypes. */
function ownData(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid();
  }
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor =
      typeof key === 'string'
        ? Object.getOwnPropertyDescriptor(raw, key)
        : undefined;
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      return invalid();
    }
    out[key as string] = descriptor.value;
  }
  return out;
}

const positiveInt = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? value
    : invalid();

function exactKeys(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalid();
}

export function parseResolveBody(
  raw: unknown,
  resolutionKey: string,
): ParsedResolveBody {
  const body = ownData(raw);
  if ('resolutionRequestId' in body) invalid();
  const withKey: Record<string, unknown> = {
    ...body,
    resolutionRequestId: resolutionKey,
  };

  switch (body.action) {
    case RESOLVE_PROVIDE_RESTOCK_ESTIMATE:
    case RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE: {
      const parsed = parseResolveHumanDecisionRequest(withKey);
      return {
        expectedVersion: parsed.expectedVersion,
        action:
          parsed.action === RESOLVE_PROVIDE_RESTOCK_ESTIMATE
            ? { type: parsed.action, restockDays: parsed.restockDays }
            : { type: parsed.action },
      };
    }
    case RESOLVE_PROVIDE_EXPIRATION_TEXT:
    case RESOLVE_REPORT_EXPIRATION_UNAVAILABLE: {
      const parsed = parseExpirationResolveHumanDecisionRequest(withKey);
      return {
        expectedVersion: parsed.expectedVersion,
        action:
          parsed.action === RESOLVE_PROVIDE_EXPIRATION_TEXT
            ? { type: parsed.action, expirationText: parsed.expirationText }
            : { type: parsed.action },
      };
    }
    case APPROVE_DELIVERY_ZONE:
    case REJECT_DELIVERY_ZONE: {
      const { expectedZoneSetVersion, ...rest } = withKey;
      const parsed = parseDeliveryZoneResolveRequest(rest);
      const zoneSet = positiveInt(expectedZoneSetVersion);
      return {
        expectedVersion: parsed.expectedVersion,
        action:
          parsed.action === APPROVE_DELIVERY_ZONE
            ? {
                type: parsed.action,
                settings: parsed.settings,
                expectedZoneSetVersion: zoneSet,
              }
            : { type: parsed.action, expectedZoneSetVersion: zoneSet },
      };
    }
    case 'CONFIRM_RECEIPT':
      exactKeys(body, ['expectedVersion', 'action', 'amountCents']);
      return {
        expectedVersion: positiveInt(body.expectedVersion),
        action: {
          type: 'CONFIRM_RECEIPT',
          amountCents: positiveInt(body.amountCents),
        },
      };
    case 'REJECT_RECEIPT': {
      exactKeys(body, [
        'expectedVersion',
        'action',
        'reason',
        'customerReason',
      ]);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      const customerReason =
        typeof body.customerReason === 'string'
          ? body.customerReason.trim()
          : '';
      if (
        reason.length === 0 ||
        reason.length > REASON_MAX ||
        customerReason.length === 0 ||
        customerReason.length > CUSTOMER_REASON_MAX
      ) {
        invalid();
      }
      return {
        expectedVersion: positiveInt(body.expectedVersion),
        action: { type: 'REJECT_RECEIPT', reason, customerReason },
      };
    }
    default:
      return invalid();
  }
}
