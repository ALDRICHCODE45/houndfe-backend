/**
 * DTO: EligibleSalesResponseDto — delivery-routes / T4
 * (eligible-sales selector).
 *
 * Wire projection for `GET /delivery-routes/eligible-sales`. The row
 * scalar types mirror the existing Prisma schema exactly:
 *
 *   Sale.id                String   → string
 *   Sale.folio             String?  → string | null
 *   Sale.status            SaleStatus            → string
 *   Sale.paymentStatus     SalePaymentStatus?    → string | null
 *   Sale.deliveryStatus    SaleDeliveryStatus    → string
 *   Sale.totalCents        Int      → number
 *   Sale.debtCents         Int      → number
 *   Sale.confirmedAt       DateTime? → ISO string | null
 *   Sale.dueDate           DateTime? → ISO string | null
 *
 * `shippingAddress` is the structured `CustomerAddress` projection (or
 * `null` when the sale has no address). `productSummary` is at most three
 * `SaleItem.productName` strings.
 *
 * `availability` is a discriminated union on `state`:
 *   AVAILABLE                         → selectable now
 *   IN_CURRENT_ROUTE { stopId, sortOrder } → already a stop of `contextRouteId`
 *   OCCUPIED { reason: 'RESERVED_BY_ROUTE', occupiedRoute } → reserved by
 *       another route. `occupiedRoute` is `null` when the caller cannot read
 *       that route instance (the row is still OCCUPIED, never AVAILABLE).
 *   INELIGIBLE { reason: 'MISSING_ADDRESS' | 'DELIVERY_STATUS' } → explainable
 *       rejection; those rows are intentionally kept in the page.
 */
export type EligibleSaleRouteStatusDto = 'DRAFT' | 'ACTIVE';

export interface EligibleSaleOccupiedRouteDto {
  id: string;
  status: EligibleSaleRouteStatusDto;
}

export type EligibleSaleAvailabilityDto =
  | { state: 'AVAILABLE' }
  | { state: 'IN_CURRENT_ROUTE'; stopId: string; sortOrder: number }
  | {
      state: 'OCCUPIED';
      reason: 'RESERVED_BY_ROUTE';
      occupiedRoute: EligibleSaleOccupiedRouteDto | null;
    }
  | {
      state: 'INELIGIBLE';
      reason: 'MISSING_ADDRESS' | 'DELIVERY_STATUS';
    };

export interface EligibleSaleShippingAddressDto {
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

export interface EligibleSaleCustomerDto {
  id: string;
  name: string;
}

export interface EligibleSaleRowDto {
  id: string;
  folio: string | null;
  status: string;
  paymentStatus: string | null;
  deliveryStatus: string;
  totalCents: number;
  debtCents: number;
  confirmedAt: string | null;
  dueDate: string | null;
  customer: EligibleSaleCustomerDto | null;
  shippingAddress: EligibleSaleShippingAddressDto | null;
  productSummary: string[];
  availability: EligibleSaleAvailabilityDto;
}

export interface EligibleSalesPaginationDto {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface EligibleSalesResponseDto {
  data: EligibleSaleRowDto[];
  pagination: EligibleSalesPaginationDto;
}
