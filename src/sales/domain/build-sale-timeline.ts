import type { SaleDetailTimelineEventDto } from '../dto/sale-detail-response.dto';

export function buildSaleTimeline(input: {
  createdAt: Date;
  confirmedAt: Date | null;
  deliveryStatus: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE';
  payments: Array<{ createdAt: Date }>;
}): SaleDetailTimelineEventDto[] {
  const saleRegisteredAt = input.createdAt;
  const paymentReceivedAt =
    input.payments
      .map((payment) => payment.createdAt)
      .sort((a, b) => a.getTime() - b.getTime())[0] ??
    input.confirmedAt ??
    input.createdAt;
  const productsDeliveredAt =
    input.deliveryStatus === 'DELIVERED'
      ? input.confirmedAt ?? paymentReceivedAt
      : paymentReceivedAt;

  return [
    { type: 'SALE_REGISTERED', at: saleRegisteredAt.toISOString() },
    { type: 'PAYMENT_RECEIVED', at: paymentReceivedAt.toISOString() },
    { type: 'PRODUCTS_DELIVERED', at: productsDeliveredAt.toISOString() },
  ];
}
