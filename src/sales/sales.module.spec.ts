import { MODULE_METADATA } from '@nestjs/common/constants';
import { SalesModule } from './sales.module';
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
