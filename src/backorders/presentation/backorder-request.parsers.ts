/**
 * Exact parsers of the three bot request shapes. The controller keeps
 * `@Body()`/`@Query()` typed `unknown` (the global pipe skips metatype
 * `Object`), so validation is owned here and every failure is the same
 * code-only `400 INVALID_BACKORDER_REQUEST`.
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  ExistingCheckoutCustomerDto,
  NewCheckoutCustomerDto,
} from '../../chatbot-api/presentation/dto/checkout.request';
import { BackorderError } from '../domain/backorder-error';
import type { BackorderIntent } from '../domain/backorder-rules';
import {
  isBackorderStatus,
  type BackorderStatusValue,
} from '../domain/backorder-status';
import type { BackorderListFilter } from '../application/backorders-bot.service';
import {
  CancelBackorderRequestDto,
  CreateBackorderRequestDto,
} from './dto/create-backorder.request';

const invalid = () => new BackorderError('INVALID_BACKORDER_REQUEST');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function validated<T extends object>(
  type: new () => T,
  value: Record<string, unknown>,
): T {
  const dto = plainToInstance(type, value);
  if (
    validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }).length > 0
  ) {
    throw invalid();
  }
  return dto;
}

export function parseCreateBackorderRequest(value: unknown): BackorderIntent {
  if (!isRecord(value)) throw invalid();
  let dto: CreateBackorderRequestDto;
  try {
    dto = validated(CreateBackorderRequestDto, value);
  } catch {
    throw invalid();
  }
  const customer =
    dto.customer instanceof ExistingCheckoutCustomerDto
      ? { mode: 'existing' as const, customerId: dto.customer.customerId }
      : dto.customer instanceof NewCheckoutCustomerDto
        ? {
            mode: 'createIfAbsent' as const,
            firstName: dto.customer.firstName,
            lastName: dto.customer.lastName ?? null,
          }
        : null;
  if (!customer) throw invalid();
  return {
    phoneCountryCode: dto.phoneCountryCode,
    phone: dto.phone,
    customer,
    productId: dto.productId,
    variantId: dto.variantId ?? null,
    quantity: dto.quantity,
    expectedReferencePriceCents: dto.expectedReferencePriceCents ?? null,
    sourceDecisionId: dto.sourceDecisionId,
    chatbotRequestId: dto.chatbotRequestId ?? null,
  };
}

/** `{ "reason": "≤280" }`, the whole body optional; blank reason is stored as null. */
export function parseCancelBackorderRequest(value: unknown): {
  reason: string | null;
} {
  if (value === undefined || value === null) return { reason: null };
  if (!isRecord(value)) throw invalid();
  let dto: CancelBackorderRequestDto;
  try {
    dto = validated(CancelBackorderRequestDto, value);
  } catch {
    throw invalid();
  }
  const reason = dto.reason?.trim();
  return { reason: reason ? reason : null };
}

const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const LIST_QUERY_KEYS = new Set([
  'phoneCountryCode',
  'phone',
  'status',
  'updatedSince',
]);

/**
 * `?phoneCountryCode=&phone=&status=WAITING,RESERVED&updatedSince=`: the phone
 * pair is both-or-neither, `status` is a comma list of known states, and
 * `updatedSince` an ISO 8601 instant with a zone. Unknown keys are rejected.
 */
export function parseListBackordersQuery(value: unknown): BackorderListFilter {
  if (!isRecord(value)) throw invalid();
  for (const [key, member] of Object.entries(value)) {
    if (!LIST_QUERY_KEYS.has(key) || typeof member !== 'string')
      throw invalid();
  }
  const { phoneCountryCode, phone, status, updatedSince } = value as Record<
    string,
    string | undefined
  >;
  if ((phoneCountryCode === undefined) !== (phone === undefined))
    throw invalid();
  if (
    phoneCountryCode !== undefined &&
    !/^[0-9]{1,10}$/.test(phoneCountryCode)
  ) {
    throw invalid();
  }
  if (phone !== undefined && !/^[0-9]{1,20}$/.test(phone)) throw invalid();

  let statuses: BackorderStatusValue[] | undefined;
  if (status !== undefined) {
    statuses = [];
    for (const part of status.split(',').map((item) => item.trim())) {
      if (!isBackorderStatus(part)) throw invalid();
      if (!statuses.includes(part)) statuses.push(part);
    }
  }

  let since: Date | undefined;
  if (updatedSince !== undefined) {
    since = new Date(updatedSince);
    if (!ISO_WITH_ZONE.test(updatedSince) || Number.isNaN(since.getTime())) {
      throw invalid();
    }
  }
  return {
    ...(phoneCountryCode !== undefined && phone !== undefined
      ? { phoneCountryCode, phone }
      : {}),
    ...(statuses ? { statuses } : {}),
    ...(since ? { updatedSince: since } : {}),
  };
}
