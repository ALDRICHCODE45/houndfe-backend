/**
 * SaleStockService error contract (O1 / T4). The HTTP statuses/bodies below
 * are what POS and the bot receive when a charge cannot be covered. Before
 * the journal both were 500 (a plain `Error('STOCK_INSUFFICIENT_AT_CONFIRM')`
 * escaped the domain filter): POS `{statusCode:500,message:'Internal server
 * error'}` and bot `{statusCode:500,error:'CHECKOUT_CREATE_FAILED'}`.
 */
import { Controller, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CheckoutController } from '../chatbot-api/presentation/checkout.controller';
import { CheckoutService } from '../chatbot-api/application/checkout.service';
import { ServiceAuthGuard } from '../chatbot-api/presentation/guards/service-auth.guard';
import { BotAuditInterceptor } from '../chatbot-api/presentation/interceptors/bot-audit.interceptor';
import {
  InsufficientStockError,
  StockBucketNotFoundError,
  StockVersionConflictError,
} from '../inventory/domain/stock-journal.errors';
import type { StockJournalWriter } from '../inventory/infrastructure/stock-journal.writer';
import { DomainExceptionFilter } from '../shared/filters/domain-exception.filter';
import type { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import type { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { IStockAlertStateRepository } from '../stock-alerts/domain/stock-alert-state.repository';
import { SaleStockService } from './sale-stock.service';

const CASHIER = '30000000-0000-4000-8000-000000000001';
const PRODUCT = '40000000-0000-4000-8000-000000000001';

function makeService(chargeError: unknown) {
  const journal = {
    charge: jest.fn().mockRejectedValue(chargeError),
    reverseSale: jest.fn(),
  };
  const outbox = { publish: jest.fn() };
  const tenantPrisma = {
    getClient: () => ({
      user: { findUnique: jest.fn().mockResolvedValue({ name: 'Cajera' }) },
    }),
    getTenantId: () => 'tenant-1',
  };
  const service = new SaleStockService(
    journal as unknown as StockJournalWriter,
    tenantPrisma as unknown as TenantPrismaService,
    outbox as unknown as OutboxWriterService,
    {} as IStockAlertStateRepository,
  );
  return { service, outbox };
}

const charge = (service: SaleStockService) =>
  service.charge({
    saleId: 'sale-1',
    items: [{ productId: PRODUCT, quantity: 3 }],
    actor: { kind: 'user', userId: CASHIER },
  });

describe('SaleStockService error mapping', () => {
  it.each([
    ['insufficient stock', new InsufficientStockError('LOT', 'lot-1', 2, 3)],
    ['missing bucket', new StockBucketNotFoundError('PRODUCT', PRODUCT)],
  ])('maps %s to STOCK_INSUFFICIENT_AT_CONFIRM', async (_label, cause) => {
    const { service, outbox } = makeService(cause);
    await expect(charge(service)).rejects.toMatchObject({
      code: 'STOCK_INSUFFICIENT_AT_CONFIRM',
    });
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it('lets unrelated journal errors through untouched', async () => {
    const conflict = new StockVersionConflictError('PRODUCT', PRODUCT, 4);
    const { service } = makeService(conflict);
    await expect(charge(service)).rejects.toBe(conflict);
  });
});

describe('insufficient stock over HTTP (contract change 500 -> 409)', () => {
  @Controller('pos-probe')
  class PosController {
    constructor(readonly stock: SaleStockService) {}
    @Post()
    chargeSale() {
      return charge(this.stock);
    }
  }

  async function app(chargeError: unknown) {
    const { service } = makeService(chargeError);
    const module = await Test.createTestingModule({
      controllers: [CheckoutController, PosController],
      providers: [
        { provide: SaleStockService, useValue: service },
        {
          provide: CheckoutService,
          useValue: { create: () => charge(service) },
        },
      ],
    })
      .overrideGuard(ServiceAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideInterceptor(BotAuditInterceptor)
      .useValue({
        intercept: (_c: unknown, next: { handle(): unknown }) => next.handle(),
      })
      .compile();
    const nest = module.createNestApplication();
    nest.useGlobalFilters(new DomainExceptionFilter());
    await nest.init();
    return nest;
  }

  const botBody = {
    phoneCountryCode: '52',
    phone: '5512345678',
    customer: { mode: 'createIfAbsent', firstName: 'Ana' },
    deliveryAddress: { mode: 'newSaved', address: { street: 'Example' } },
    sale: {
      cashierUserId: CASHIER,
      items: [
        {
          productId: PRODUCT,
          productName: 'Product',
          quantity: 3,
          unitPriceCents: 1000,
        },
      ],
      expectedTotalCents: 3000,
    },
  };

  it('POS receives 409 with the STOCK_INSUFFICIENT_AT_CONFIRM envelope', async () => {
    const nest = await app(new InsufficientStockError('LOT', 'lot-1', 2, 3));
    const res = await request(nest.getHttpServer()).post('/pos-probe');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      statusCode: 409,
      error: 'STOCK_INSUFFICIENT_AT_CONFIRM',
    });
    await nest.close();
  });

  it('the bot checkout receives 409 STOCK_INSUFFICIENT_AT_CONFIRM', async () => {
    const nest = await app(new InsufficientStockError('LOT', 'lot-1', 2, 3));
    const res = await request(nest.getHttpServer())
      .post('/chatbot-api/checkouts')
      .set('x-idempotency-key', 'k'.repeat(16))
      .send(botBody);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      statusCode: 409,
      error: 'STOCK_INSUFFICIENT_AT_CONFIRM',
    });
    await nest.close();
  });
});
