/**
 * DTO: DeliveryRouteResponseDto — delivery-routes / WU2.
 *
 * Wire projection for the read-model endpoints (list + get-by-id).
 * Mirrors `SaleDetailResponseDto`'s assembly style (design §7.1):
 * route fields + driver projection + stops[] with embedded saleFolio /
 * customer / shippingAddress.
 *
 * The `activeRouteId` marker column is intentionally absent — it is
 * authorization / invariant machinery and never appears on the wire
 * (design §4.2 last paragraph).
 *
 * The timeline is wired in WU3 (`buildDeliveryRouteTimeline`); the WU2
 * DTO carries the `timeline` field with an empty array placeholder so
 * the FE contract is stable across the WU2 → WU3 transition.
 */
export type DeliveryRouteStatusDto =
  | 'DRAFT'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED';

export type DeliveryRouteStopStatusDto =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'SKIPPED';

/**
 * WU3 — `buildDeliveryRouteTimeline` fills this with the discriminated
 * union from design §7.1. WU2 returned an empty array; WU3 narrows the
 * shape so the FE has a stable contract.
 */
export type DeliveryRouteTimelineActorDto = {
  id: string;
  name: string;
};

export type DeliveryRouteTimelineEventDto =
  | {
      type: 'ROUTE_CREATED';
      at: string;
      actor: DeliveryRouteTimelineActorDto | null;
    }
  | {
      type: 'ROUTE_STARTED';
      at: string;
      actor: DeliveryRouteTimelineActorDto | null;
    }
  | {
      type: 'STOP_CHECKED_IN';
      at: string;
      stopId: string;
      sortOrder: number;
      actor: DeliveryRouteTimelineActorDto | null;
    }
  | {
      type: 'ROUTE_COMPLETED';
      at: string;
      actor: DeliveryRouteTimelineActorDto | null;
    }
  | {
      type: 'ROUTE_CANCELLED';
      at: string;
      actor: DeliveryRouteTimelineActorDto | null;
    };

export interface DeliveryRouteDriverDto {
  id: string;
  name: string;
  email: string;
}

export interface DeliveryRouteCustomerDto {
  id: string;
  name: string;
  email: string | null;
}

export interface DeliveryRouteShippingAddressDto {
  id: string;
  street: string | null;
  exteriorNumber: string | null;
  interiorNumber: string | null;
  zipCode: string | null;
  neighborhood: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
  label: string | null;
}

export interface DeliveryRouteStopDto {
  id: string;
  saleId: string;
  saleFolio: string | null;
  sortOrder: number;
  status: DeliveryRouteStopStatusDto;
  checkedInAt: string | null;
  completedAt: string | null;
  customer: DeliveryRouteCustomerDto | null;
  shippingAddress: DeliveryRouteShippingAddressDto | null;
}

export interface DeliveryRouteResponseDto {
  id: string;
  status: DeliveryRouteStatusDto;
  driver: DeliveryRouteDriverDto | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  notes: string | null;
  stops: DeliveryRouteStopDto[];
  /** WU3 — empty array in WU2. Field is reserved so the FE contract
   *  is stable across the chained-PR boundary. */
  timeline: DeliveryRouteTimelineEventDto[];
}
