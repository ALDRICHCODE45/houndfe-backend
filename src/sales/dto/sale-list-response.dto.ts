export interface SaleListRowDto {
  id: string;
  folio: string | null;
  status: string;
  paymentStatus: string | null;
  deliveryStatus: string;
  totalCents: number;
  confirmedAt: Date | null;
  customer: { id: string; name: string } | null;
  cashier: { id: string; name: string };
  seller: { id: string; name: string } | null;
}

export interface SaleListResponseDto {
  data: SaleListRowDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  counts: {
    all: number;
    pendingPayments: number;
    notDelivered: number;
  };
}
