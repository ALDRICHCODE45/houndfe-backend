import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PrismaCatalogEditorial } from './infrastructure/prisma-catalog-editorial';
import { PrismaEditorialAuthority } from './infrastructure/prisma-editorial-authority';
import {
  EDITORIAL_READER,
  EditorialReadController,
} from './http/editorial-read.controller';

// The root already supplies Prisma/CLS and registers the Passport JWT strategy.
@Module({
  controllers: [EditorialReadController],
  providers: [
    JwtAuthGuard,
    TenantContextGuard,
    {
      provide: EDITORIAL_READER,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaCatalogEditorial(
          prisma,
          new PrismaEditorialAuthority(prisma),
        ),
    },
  ],
})
export class CatalogEditorialReadModule {}
