/**
 * shipping-zones / T1 (S1) — PORT: store-side delivery-zone persistence.
 *
 * The adapter resolves `tenantId` from `TenantPrismaService` (never from the
 * caller) and repeats it in every WHERE clause, so another tenant's zone is
 * indistinguishable from a missing one. The actor id comes from the verified
 * JWT; its display name is snapshotted from the User row at write time.
 */
import { DomainError } from '../../shared/domain/domain-error';
import type {
  DeliveryZoneTypeValue,
  ZoneSettings,
} from './delivery-zone.policy';

/** Stable, value-free store-side failure codes. */
export type DeliveryZoneErrorCode =
  | 'DELIVERY_ZONE_NOT_FOUND'
  | 'DELIVERY_ZONE_VALIDATION_NOT_FOUND'
  | 'DELIVERY_ZONE_VALIDATION_PENDING'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ALREADY_RESOLVED'
  | 'UNAUTHORIZED';

export class DeliveryZoneError extends DomainError {
  constructor(code: DeliveryZoneErrorCode, message: string) {
    super(message, code);
  }
}

export interface DeliveryZoneRecord {
  id: string;
  zipCode: string;
  type: DeliveryZoneTypeValue;
  surchargeCents: number | null;
  etaDays: number | null;
  state: string | null;
  municipality: string | null;
  neighborhood: string | null;
  isActive: boolean;
  approvedById: string;
  approvedByDisplayName: string;
  approvedAt: Date;
  sourceValidationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListDeliveryZonesQuery {
  page: number;
  limit: number;
  search?: string;
  type?: DeliveryZoneTypeValue;
  isActive?: boolean;
}

export interface DeliveryZonePage {
  items: DeliveryZoneRecord[];
  totalCount: number;
}

export interface UpsertDeliveryZoneCommand {
  zipCode: string;
  settings: ZoneSettings;
  state: string | null;
  municipality: string | null;
  neighborhood: string | null;
  actorUserId: string;
  actorIsSuperAdmin: boolean;
}

export interface IDeliveryZoneRepository {
  list(query: ListDeliveryZonesQuery): Promise<DeliveryZonePage>;
  findByZipCode(zipCode: string): Promise<DeliveryZoneRecord | null>;
  /**
   * Create or replace the zone for one postal code and (re)activate it. Fails
   * with `DELIVERY_ZONE_VALIDATION_PENDING` while a validation is open for the
   * same postal code: the store must resolve the validation instead, so every
   * waiting requester is settled in the same transaction.
   */
  upsert(command: UpsertDeliveryZoneCommand): Promise<DeliveryZoneRecord>;
  /** Soft-deactivate; the postal code becomes unknown to the bot again. */
  deactivate(zipCode: string): Promise<DeliveryZoneRecord>;
}

export const DELIVERY_ZONE_REPOSITORY = Symbol('DELIVERY_ZONE_REPOSITORY');
