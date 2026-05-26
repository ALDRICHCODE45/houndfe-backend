import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { PrismaCategoryRepository } from './infrastructure/prisma-category.repository';
import { CATEGORY_REPOSITORY } from './domain/category.repository';

@Module({
  imports: [AuthModule], // Provides JwtAuthGuard, PermissionsGuard, CaslAbilityFactory
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
