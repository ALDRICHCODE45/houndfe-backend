import { Module } from '@nestjs/common';
import { SaleCommentsController } from './sale-comments.controller';
import { SaleCommentsService } from './sale-comments.service';
import { SALE_COMMENT_REPOSITORY } from './domain/sale-comment.repository';
import { PrismaSaleCommentRepository } from './infrastructure/prisma-sale-comment.repository';

@Module({
  controllers: [SaleCommentsController],
  providers: [
    SaleCommentsService,
    {
      provide: SALE_COMMENT_REPOSITORY,
      useClass: PrismaSaleCommentRepository,
    },
  ],
  exports: [SaleCommentsService, SALE_COMMENT_REPOSITORY],
})
export class SaleCommentsModule {}
