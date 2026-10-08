/**
 * PORT: eligible-sales reader — delivery-routes / T4.
 *
 * Read seam between `EligibleSalesService` and the Prisma adapter. Keeps
 * the service unit-testable without a database. Every method is
 * tenant-qualified by the caller-provided `tenantId`; the adapter ALSO
 * runs under the ambient tenant CLS scope (defense in depth).
 *
 * The projections here are deliberately raw facts (schema types plus the
 * occupancy marker). Mapping to the discriminating `availability` state
 * and any permission-based redaction happens in the service.
 */
import type { Prisma } from '@prisma/client';

export const ELIGIBLE_SALES_READER = Symbol('ELIGIBLE_SALES_READER');

export interface EligibleSalesReadInput {
  tenantId: string;
  page: number;
  limit: number;
  q?: string;
  /**
   * CASL-derived row scope for `read:Sale`, translated to a Prisma filter.
   * `null` means the ability grants an unconditional (tenant-wide) scope.
   * An impossible filter (`{ id: { in: [] } }`) means the caller holds no
   * readable scope and the page MUST be empty.
   */
  saleScope: Prisma.SaleWhereInput | null;
}

export interface EligibleSaleCustomerProjection {
  id: string;
  firstName: string;
  lastName: string | null;
}

export interface EligibleSaleAddressProjection {
  id: string;
  label: string | null;
  street: string;
  exteriorNumber: string | null;
  interiorNumber: string | null;
  neighborhood: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
}

/**
 * Occupancy fact derived from the `DeliveryRouteStop.activeRouteId`
 * reservation marker. `routeStatus` is the raw status string; the service
 * decides whether it is exposable.
 */
export interface EligibleSaleOccupancyProjection {
  routeId: string;
  routeStatus: string;
  routeDriverUserId: string;
}

export interface EligibleSaleRowProjection {
  id: string;
  folio: string | null;
  status: string;
  paymentStatus: string | null;
  deliveryStatus: string;
  totalCents: number;
  debtCents: number;
  confirmedAt: Date | null;
  dueDate: Date | null;
  customer: EligibleSaleCustomerProjection | null;
  shippingAddress: EligibleSaleAddressProjection | null;
  productNames: string[];
  occupancy: EligibleSaleOccupancyProjection | null;
}

export interface EligibleSalesPageProjection {
  rows: EligibleSaleRowProjection[];
  total: number;
}

export interface EligibleSalesContextStopProjection {
  stopId: string;
  saleId: string;
  sortOrder: number;
}

export interface EligibleSalesContextRouteProjection {
  id: string;
  status: string;
  driverUserId: string;
  stops: EligibleSalesContextStopProjection[];
}

export interface IEligibleSalesReader {
  findEligibleSales(
    input: EligibleSalesReadInput,
  ): Promise<EligibleSalesPageProjection>;

  /**
   * Minimal tenant-qualified route project for `contextRouteId`
   * validation. `null` on a missing/foreign route (never an existence
   * oracle for the caller).
   */
  findContextRoute(input: {
    tenantId: string;
    routeId: string;
  }): Promise<EligibleSalesContextRouteProjection | null>;
}
