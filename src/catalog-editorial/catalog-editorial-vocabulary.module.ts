import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { EditorialVocabularyController } from './http/editorial-vocabulary.controller';
import { EditorialReaderAuthority } from './infrastructure/editorial-reader-authority';
import { PrismaEditorialVocabulary } from './infrastructure/prisma-editorial-vocabulary';

// Root supplies Prisma/CLS/JWT. Product context can add its own H1 authority provider.
@Module({
  controllers: [EditorialVocabularyController],
  providers: [
    JwtAuthGuard,
    TenantContextGuard,
    {
      provide: EditorialReaderAuthority,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new EditorialReaderAuthority(prisma),
    },
    {
      provide: PrismaEditorialVocabulary,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaEditorialVocabulary(prisma),
    },
  ],
})
export class CatalogEditorialVocabularyModule {}
