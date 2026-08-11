import { BadRequestException } from '@nestjs/common';
import { SalesPaymentsController } from './sales-payments.controller';
import type { SalesService } from './sales.service';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

type PaymentsServiceMock = Pick<
  SalesService,
  'addPayment' | 'updatePaymentReference'
>;

function makeMockService(): jest.Mocked<PaymentsServiceMock> {
  return {
    addPayment: jest.fn(),
    updatePaymentReference: jest.fn(),
  };
}

function makeUser(userId: string): AuthenticatedUser {
  return {
    userId,
    email: `${userId}@test.com`,
    tenantId: null,
    tenantSlug: null,
    isSuperAdmin: false,
  };
}

describe('SalesPaymentsController', () => {
  it('rejects request when idempotency header is missing', async () => {
    const service = makeMockService();
    const controller = new SalesPaymentsController(
      service as unknown as SalesService,
    );

    expect(() =>
      controller.addPayment(
        '66f64f29-cde5-41ac-baf2-30ce8e503f1a',
        { method: 'cash', amountCents: 1000 },
        '',
        makeUser('user-1'),
      ),
    ).toThrow(BadRequestException);
  });

  it('forwards endpoint payload to service', async () => {
    const service = makeMockService();
    const controller = new SalesPaymentsController(
      service as unknown as SalesService,
    );
    service.addPayment.mockResolvedValue({ saleId: 'sale-1' });

    await controller.addPayment(
      '66f64f29-cde5-41ac-baf2-30ce8e503f1a',
      { method: 'transfer', amountCents: 1000, reference: 'TRF-1' },
      'idem-key-1',
      makeUser('user-1'),
    );

    expect(service.addPayment).toHaveBeenCalledWith(
      '66f64f29-cde5-41ac-baf2-30ce8e503f1a',
      'user-1',
      { method: 'transfer', amountCents: 1000, reference: 'TRF-1' },
      'idem-key-1',
    );
  });

  it('forwards array-shaped payload and trims idempotency key', async () => {
    const service = makeMockService();
    const controller = new SalesPaymentsController(
      service as unknown as SalesService,
    );
    service.addPayment.mockResolvedValue({
      saleId: 'sale-1',
      paymentIds: ['p-1', 'p-2'],
    });

    await controller.addPayment(
      '66f64f29-cde5-41ac-baf2-30ce8e503f1a',
      {
        payments: [
          { method: 'cash', amountCents: 500 },
          { method: 'transfer', amountCents: 300, reference: 'TRX-1' },
        ],
      } as never,
      '  idem-key-2  ',
      makeUser('user-1'),
    );

    expect(service.addPayment).toHaveBeenCalledWith(
      '66f64f29-cde5-41ac-baf2-30ce8e503f1a',
      'user-1',
      {
        payments: [
          { method: 'cash', amountCents: 500 },
          { method: 'transfer', amountCents: 300, reference: 'TRX-1' },
        ],
      },
      'idem-key-2',
    );
  });

  describe('updatePaymentReference', () => {
    const saleId = '66f64f29-cde5-41ac-baf2-30ce8e503f1a';
    const paymentId = '1c5fdc6f-5c9f-4b3d-8b1a-9f0e2b7a4c01';

    it('forwards PATCH params and body to service', async () => {
      const service = makeMockService();
      const controller = new SalesPaymentsController(
        service as unknown as SalesService,
      );
      service.updatePaymentReference.mockResolvedValue({
        paymentId,
        method: 'CARD_DEBIT',
        amountCents: 2000,
        reference: 'REF-1',
        paidAt: new Date('2026-05-08T10:20:00.000Z'),
      });

      await controller.updatePaymentReference(saleId, paymentId, {
        reference: 'REF-1',
      });

      expect(service.updatePaymentReference).toHaveBeenCalledWith(
        saleId,
        paymentId,
        { reference: 'REF-1' },
      );
    });

    it('forwards null reference (clear) to service', async () => {
      const service = makeMockService();
      const controller = new SalesPaymentsController(
        service as unknown as SalesService,
      );
      service.updatePaymentReference.mockResolvedValue({
        paymentId,
        method: 'CARD_DEBIT',
        amountCents: 2000,
        reference: null,
        paidAt: new Date('2026-05-08T10:20:00.000Z'),
      });

      await controller.updatePaymentReference(saleId, paymentId, {
        reference: null,
      });

      expect(service.updatePaymentReference).toHaveBeenCalledWith(
        saleId,
        paymentId,
        { reference: null },
      );
    });
  });
});
