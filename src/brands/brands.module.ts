import { Module } from '@nestjs/common';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';
import { PrismaBrandRepository } from './infrastructure/prisma-brand.repository';
import { BRAND_REPOSITORY } from './domain/brand.repository';

@Module({
  controllers: [BrandsController],
  providers: [
    BrandsService,
    {
      provide: BRAND_REPOSITORY,
      useClass: PrismaBrandRepository,
    },
  ],
  exports: [BrandsService],
})
export class BrandsModule {}
