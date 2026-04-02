import { Module } from '@nestjs/common';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { PrismaCategoryRepository } from './infrastructure/prisma-category.repository';
import { CATEGORY_REPOSITORY } from './domain/category.repository';

@Module({
  controllers: [CategoriesController],
  providers: [
    CategoriesService,
    {
      provide: CATEGORY_REPOSITORY,
      useClass: PrismaCategoryRepository,
    },
  ],
  exports: [CategoriesService],
})
export class CategoriesModule {}
