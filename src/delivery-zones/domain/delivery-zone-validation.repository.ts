/**
 * shipping-zones / T1 (S2, S3) — PORT: store-side zone validations.
 *
 * Resolution is a versioned one-winner CAS (version 1 -> 2) with the closed
 * action union below. Resolving creates/updates the zone and settles every
 * PENDING requester of the validation in ONE transaction, under the same
 * per-postal-code lock as the bot intake.
 */
import type {
  DeliveryZoneTypeValue,
  ZoneSettings,
} from './delivery-zone.policy';
import type { DeliveryZoneRecord } from './delivery-zone.repository';

export const APPROVE_DELIVERY_ZONE = 'APPROVE_DELIVERY_ZONE';
export const REJECT_DELIVERY_ZONE = 'REJECT_DELIVERY_ZONE';

export type DeliveryZoneResolutionActionValue =
  | typeof APPROVE_DELIVERY_ZONE
  | typeof REJECT_DELIVERY_ZONE;

interface ResolveCommandBase {
  validationId: string;
  expectedVersion: number;
  resolutionRequestId: string;
  actorUserId: string;
  actorIsSuperAdmin: boolean;
}

/** APPROVE carries FREE | SURCHARGE | CARRIER_ONLY plus its surcharge/ETA. */
export interface ApproveDeliveryZoneCommand extends ResolveCommandBase {
  action: typeof APPROVE_DELIVERY_ZONE;
  settings: ZoneSettings & { type: Exclude<DeliveryZoneTypeValue, 'DENIED'> };
}

/** REJECT always settles the zone as DENIED; it carries no settings. */
export interface RejectDeliveryZoneCommand extends ResolveCommandBase {
  action: typeof REJECT_DELIVERY_ZONE;
}

export type ResolveDeliveryZoneValidationCommand =
  | ApproveDeliveryZoneCommand
  | RejectDeliveryZoneCommand;

export interface DeliveryZoneValidationRecord {
  id: string;
  zipCode: string;
  state: string;
  municipality: string;
  neighborhood: string;
  status: 'PENDING' | 'RESOLVED';
  version: number;
  createdAt: Date;
  /** Requesters attached (PENDING ones while the validation is open). */
  requesterCount: number;
  /** Oldest PENDING requester's last message; `null` once resolved. */
  oldestLastCustomerMessageAt: Date | null;
  resolutionAction: DeliveryZoneResolutionActionValue | null;
  zoneType: DeliveryZoneTypeValue | null;
  surchargeCents: number | null;
  etaDays: number | null;
  resolvedAt: Date | null;
  resolvedByActorId: string | null;
  resolvedByDisplayName: string | null;
}

export interface ListPendingValidationsQuery {
  page: number;
  limit: number;
  /** Exactly five digits; narrows the list to that postal code. */
  zipCode?: string;
}

export interface DeliveryZoneValidationPage {
  items: DeliveryZoneValidationRecord[];
  totalCount: number;
}

export interface ResolveDeliveryZoneValidationResult {
  status: 'resolved' | 'replayed';
  validation: DeliveryZoneValidationRecord;
  zone: DeliveryZoneRecord;
}

export interface IDeliveryZoneValidationRepository {
  /** PENDING validations, oldest pending requester message first. */
  listPending(
    query: ListPendingValidationsQuery,
  ): Promise<DeliveryZoneValidationPage>;
  findById(id: string): Promise<DeliveryZoneValidationRecord | null>;
  resolve(
    command: ResolveDeliveryZoneValidationCommand,
  ): Promise<ResolveDeliveryZoneValidationResult>;
}

export const DELIVERY_ZONE_VALIDATION_REPOSITORY = Symbol(
  'DELIVERY_ZONE_VALIDATION_REPOSITORY',
);
