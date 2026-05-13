import type { SaleDetailTimelineEventDto } from '../dto/sale-detail-response.dto';

export function buildSaleTimeline(input: {
  createdAt: Date;
  confirmedAt: Date | null;
  deliveryStatus: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE';
  payments: Array<{ createdAt: Date }>;
}): SaleDetailTimelineEventDto[] {
  const saleRegisteredAt = input.createdAt;
  const sortedPaymentEvents: SaleDetailTimelineEventDto[] = input.payments
    .map((payment) => payment.createdAt)
    .sort((a, b) => a.getTime() - b.getTime())
    .map((paymentCreatedAt) => ({
      type: 'PAYMENT_RECEIVED',
      at: paymentCreatedAt.toISOString(),
    }));
  const productsDeliveredAt = input.confirmedAt ?? input.createdAt;

  return [
    { type: 'SALE_REGISTERED', at: saleRegisteredAt.toISOString() },
    ...sortedPaymentEvents,
    { type: 'PRODUCTS_DELIVERED', at: productsDeliveredAt.toISOString() },
  ];
}
