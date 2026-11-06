import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { ReceiptReadError } from '../domain/receipt-read.errors';

export type BotReceiptOutcome = {
  status: 'PENDING' | 'CONFIRMED' | 'REJECTED';
  /** Present only when REJECTED: customer-safe text the bot may relay. */
  customerReason?: string;
  /** Live sale state (the source of truth for what is still owed). */
  sale: {
    debtCents: number;
    paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null;
  };
};

/**
 * Review outcome for the chatbot's poll. Deliberately narrow: never the
 * internal rejection reason, the reviewer, storage keys, extracted data or
 * any file route.
 */
@Injectable()
export class ReceiptStatusService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getForBot(receiptId: string): Promise<BotReceiptOutcome> {
    const tenantId = this.tenantPrisma.getTenantId();
    const row = await this.tenantPrisma.getClient().receiptEvidence.findFirst({
      where: { id: receiptId, tenantId },
      select: {
        status: true,
        customerReason: true,
        sale: { select: { debtCents: true, paymentStatus: true } },
      },
    });
    if (!row) {
      throw new ReceiptReadError('RECEIPT_NOT_FOUND', 'Receipt not found');
    }

    return {
      status: row.status,
      ...(row.status === 'REJECTED' && row.customerReason
        ? { customerReason: row.customerReason }
        : {}),
      sale: {
        debtCents: row.sale.debtCents,
        paymentStatus: row.sale.paymentStatus,
      },
    };
  }
}
