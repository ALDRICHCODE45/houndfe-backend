/**
 * shipping-zones / T1 (S2) — PORT: bot DELIVERY_ZONE requester cycle.
 *
 * One requester row per bot `sourceRequestId`; each owns its own
 * PENDING -> RESOLVED -> ACK cycle and is served through the existing bot
 * routes (`POST /chatbot-api/human-decisions`, `GET .../:id`,
 * `POST .../:id/application-outcome`) where `:id` is the requester id.
 *
 *   - Same `sourceRequestId` + same canonical hash: replay (same requester).
 *     Same id + different hash: `IDEMPOTENCY_CONFLICT` (409).
 *   - Active zone for the postal code: the requester is created RESOLVED
 *     (`EXISTING_ZONE`) and no validation is opened.
 *   - Otherwise it joins the single PENDING validation of the postal code,
 *     opening it (and its notification outbox row) when there is none.
 *
 * Tenant always comes from CLS (ServiceAuthGuard), never from the body.
 */
import { DomainError } from '../../shared/domain/domain-error';
import type {
  BotApplicationOutcomeResult,
  RecordBotApplicationOutcomeCommand,
} from '../../human-decisions/domain/bot-application-outcome.repository';
import type { DeliveryZoneTypeValue } from './delivery-zone.policy';
import type { DeliveryZoneIntakeRequest } from './delivery-zone-intake.request';

export type DeliveryZoneIntakeErrorCode = 'IDEMPOTENCY_CONFLICT';

/** Value-free intake failure, mapped by `HumanDecisionHttpFilter`. */
export class DeliveryZoneIntakeError extends DomainError {
  constructor(code: DeliveryZoneIntakeErrorCode, message: string) {
    super(message, code);
  }
}

export type DeliveryZoneRequestResolutionSourceValue =
  | 'VALIDATION'
  | 'EXISTING_ZONE';

/** Bot-safe requester projection source: no phone, no conversation ref. */
export interface DeliveryZoneRequestRecord {
  id: string;
  sourceRequestId: string;
  validationId: string | null;
  branchName: string | null;
  zipCode: string;
  state: string;
  municipality: string;
  neighborhood: string;
  status: 'PENDING' | 'RESOLVED';
  version: number;
  createdAt: Date;
  resolutionSource: DeliveryZoneRequestResolutionSourceValue | null;
  zoneType: DeliveryZoneTypeValue | null;
  surchargeCents: number | null;
  etaDays: number | null;
  resolvedAt: Date | null;
}

export interface SubmitDeliveryZoneIntakeCommand {
  request: DeliveryZoneIntakeRequest;
  submittedCredentialId: string;
}

export interface DeliveryZoneIntakeResult {
  status: 'created' | 'replayed';
  record: DeliveryZoneRequestRecord;
}

export interface IDeliveryZoneBotRepository {
  submit(
    command: SubmitDeliveryZoneIntakeCommand,
  ): Promise<DeliveryZoneIntakeResult>;
  /** Tenant-scoped requester by id, or `null` (missing or foreign). */
  findRequestById(id: string): Promise<DeliveryZoneRequestRecord | null>;
  /**
   * One terminal ACK per requester, same contract as the RESTOCK ACK
   * (`BotApplicationOutcomeError` codes) with a 24 h application window.
   */
  recordOutcome(
    command: RecordBotApplicationOutcomeCommand,
  ): Promise<BotApplicationOutcomeResult>;
}

export const DELIVERY_ZONE_BOT_REPOSITORY = Symbol(
  'DELIVERY_ZONE_BOT_REPOSITORY',
);

/** Outbox event for the staff email (S3). */
export const DELIVERY_ZONE_VALIDATION_REQUESTED_EVENT =
  'delivery_zone.validation.requested';

export interface DeliveryZoneValidationRequestedPayload {
  tenantId: string;
  validationId: string;
  branchName: string | null;
  zipCode: string;
  state: string;
  municipality: string;
  neighborhood: string;
  /** ISO: the opening requester's last customer message. */
  lastCustomerMessageAt: string;
  /** ISO: `lastCustomerMessageAt + 24 h` (WhatsApp window). */
  deadlineAt: string;
}
