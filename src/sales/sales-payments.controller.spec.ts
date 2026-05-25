import { BadRequestException } from '@nestjs/common';
import { SalesPaymentsController } from './sales-payments.controller';
import type { SalesService } from './sales.service';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

type PaymentsServiceMock = Pick<SalesService, 'addPayment'>;

function makeMockService(): jest.Mocked<PaymentsServiceMock> {
  return {
    addPayment: jest.fn(),
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
    const controller = new SalesPaymentsController(service as unknown as SalesService);

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
    const controller = new SalesPaymentsController(service as unknown as SalesService);
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
    const controller = new SalesPaymentsController(service as unknown as SalesService);
    service.addPayment.mockResolvedValue({ saleId: 'sale-1', paymentIds: ['p-1', 'p-2'] });

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
});
