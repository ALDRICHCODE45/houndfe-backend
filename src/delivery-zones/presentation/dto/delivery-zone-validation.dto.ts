/**
 * shipping-zones / T1 (S3) — store projection of a zone validation, with the
 * "Urgencia + plazo" block derived from the oldest pending requester.
 * Customer phone and conversation reference are never projected.
 */
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  computeValidationUrgency,
  type DeliveryZoneTypeValue,
  type ValidationUrgency,
} from '../../domain/delivery-zone.policy';
import type {
  DeliveryZoneResolutionActionValue,
  DeliveryZoneValidationRecord,
} from '../../domain/delivery-zone-validation.repository';

export class ListDeliveryZoneValidationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export interface DeliveryZoneValidationResponse {
  id: string;
  zipCode: string;
  state: string;
  municipality: string;
  neighborhood: string;
  status: 'PENDING' | 'RESOLVED';
  version: number;
  createdAt: string;
  requesterCount: number;
  /** Oldest pending requester's last message; null once resolved. */
  lastCustomerMessageAt: string | null;
  urgency: ValidationUrgency | null;
  resolution: {
    action: DeliveryZoneResolutionActionValue;
    zoneType: DeliveryZoneTypeValue;
    surchargeCents: number | null;
    etaDays: number | null;
    resolvedAt: string;
    resolvedBy: { id: string; displayName: string };
  } | null;
}

export function toDeliveryZoneValidationResponse(
  record: DeliveryZoneValidationRecord,
  now: Date,
): DeliveryZoneValidationResponse {
  const oldest = record.oldestLastCustomerMessageAt;
  const resolved =
    record.status === 'RESOLVED' &&
    record.resolutionAction !== null &&
    record.zoneType !== null &&
    record.resolvedAt !== null &&
    record.resolvedByActorId !== null &&
    record.resolvedByDisplayName !== null;
  if (record.status === 'RESOLVED' && !resolved) {
    throw new Error('Malformed resolved delivery-zone validation');
  }
  return {
    id: record.id,
    zipCode: record.zipCode,
    state: record.state,
    municipality: record.municipality,
    neighborhood: record.neighborhood,
    status: record.status,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    requesterCount: record.requesterCount,
    lastCustomerMessageAt: oldest === null ? null : oldest.toISOString(),
    urgency:
      record.status === 'PENDING' && oldest !== null
        ? computeValidationUrgency(oldest, now)
        : null,
    resolution: resolved
      ? {
          action: record.resolutionAction!,
          zoneType: record.zoneType!,
          surchargeCents: record.surchargeCents,
          etaDays: record.etaDays,
          resolvedAt: record.resolvedAt!.toISOString(),
          resolvedBy: {
            id: record.resolvedByActorId!,
            displayName: record.resolvedByDisplayName!,
          },
        }
      : null,
  };
}
