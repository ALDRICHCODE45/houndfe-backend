import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { EditorialVocabularyController } from './http/editorial-vocabulary.controller';
import { EditorialContextController } from './http/editorial-context.controller';
import { PrismaEditorialAuthority } from './infrastructure/prisma-editorial-authority';
import { PrismaEditorialContext } from './infrastructure/prisma-editorial-context';
import { EditorialReaderAuthority } from './infrastructure/editorial-reader-authority';
import { PrismaEditorialVocabulary } from './infrastructure/prisma-editorial-vocabulary';

// Root supplies Prisma/CLS/JWT; Product context uses a separate unchanged H1 authority.
@Module({
  controllers: [EditorialVocabularyController, EditorialContextController],
  providers: [
    JwtAuthGuard,
    TenantContextGuard,
    {
      provide: PrismaEditorialAuthority,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaEditorialAuthority(prisma),
    },
    {
      provide: PrismaEditorialContext,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new PrismaEditorialContext(prisma),
    },
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
