import type { SaleDetailTimelineEventDto } from '../dto/sale-detail-response.dto';

export function buildSaleTimeline(input: {
  createdAt: Date;
  confirmedAt: Date | null;
  deliveryStatus: 'PENDING' | 'DELIVERED' | 'NOT_APPLICABLE' | 'SHIPPED';
  register: string;
  cashier: { id: string; name: string } | null;
  payments: Array<{
    method: string;
    amountCents: number;
    reference: string | null;
    createdAt: Date;
    userId: string | null;
    user: { id: string; name: string } | null;
    // Custom Payment Methods (custom-payment-methods / WU2 — D10):
    // optional branded identity surfaced from `metadataJson.catalog`.
    // Falls back to the base-category label when absent (legacy rows).
    paymentMethodName?: string;
    paymentMethodSubtitle?: string;
  }>;
  comments?: Array<{
    id: string;
    createdAt: Date;
    body: string;
    author: { id: string; name: string } | null;
  }>;
}): SaleDetailTimelineEventDto[] {
  const sortedPaymentEvents: SaleDetailTimelineEventDto[] = input.payments
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((payment) => ({
      type: 'PAYMENT_RECEIVED',
      at: payment.createdAt.toISOString(),
      method: payment.method,
      amountCents: payment.amountCents,
      reference: payment.reference,
      actor: payment.user ?? input.cashier,
      register: input.register,
      // Custom Payment Methods (custom-payment-methods / WU2 — D10):
      // only include the branded fields when present so legacy rows
      // stay absent on the wire (the base-category label remains the
      // fallback via the DTO mapper).
      paymentMethodName: payment.paymentMethodName,
      paymentMethodSubtitle: payment.paymentMethodSubtitle,
    }));
  const timeline: SaleDetailTimelineEventDto[] = [
    {
      type: 'SALE_REGISTERED',
      at: input.createdAt.toISOString(),
      actor: input.cashier,
      register: input.register,
    },
    ...sortedPaymentEvents,
    ...(input.comments ?? [])
      .filter(
        (
          comment,
        ): comment is {
          id: string;
          createdAt: Date;
          body: string;
          author: { id: string; name: string };
        } => comment.author !== null,
      )
      .map((comment) => ({
        type: 'COMMENT' as const,
        at: comment.createdAt.toISOString(),
        actor: comment.author,
        body: comment.body,
        commentId: comment.id,
      })),
  ];

  if (input.deliveryStatus === 'DELIVERED') {
    timeline.push({
      type: 'PRODUCTS_DELIVERED',
      at: (input.confirmedAt ?? input.createdAt).toISOString(),
      actor: input.cashier,
      register: input.register,
    });
  }

  return timeline.sort((a, b) => a.at.localeCompare(b.at));
}