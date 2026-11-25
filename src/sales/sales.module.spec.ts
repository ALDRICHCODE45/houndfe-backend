import { MODULE_METADATA } from '@nestjs/common/constants';
import { SalesModule } from './sales.module';
import { SalesCustomerMonthlyController } from './sales-customer-monthly.controller';
import { SALES_CLOCK } from './sales.service';
import { ReceiptReviewController } from './review/receipt-review.controller';
import { ReceiptReviewService } from './review/receipt-review.service';
import { RECEIPT_REVIEW_REPOSITORY } from './review/domain/receipt-review.repository';
import { PrismaReceiptReviewRepository } from './review/infrastructure/prisma-receipt-review.repository';

describe('SalesModule receipt review registration', () => {
  it('registers the receipt review controller, service, and repository adapter binding', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      SalesModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      SalesModule,
    ) as unknown[];

    expect(controllers).toContain(ReceiptReviewController);
    expect(providers).toContain(ReceiptReviewService);
    expect(providers).toContainEqual({
      provide: RECEIPT_REVIEW_REPOSITORY,
      useClass: PrismaReceiptReviewRepository,
    });
  });
});

describe('SalesModule customer monthly registration (sales-history-redesign S4)', () => {
  it('registers GET /customers/:customerId/sales-monthly in the sales module', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      SalesModule,
    ) as unknown[];

    expect(controllers).toContain(SalesCustomerMonthlyController);
  });

  it('binds the sales clock to the system clock', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      SalesModule,
    ) as Array<{ provide?: unknown; useValue?: () => Date }>;
    const clock = providers.find((p) => p.provide === SALES_CLOCK);

    expect(clock?.useValue?.()).toBeInstanceOf(Date);
    expect(
      Math.abs(clock!.useValue!().getTime() - Date.now()),
    ).toBeLessThan(5_000);
  });
});
