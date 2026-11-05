import { Module } from '@nestjs/common';
import { EDITORIAL_SAVE_WRITER } from './application/editorial-save-writer';
import { PrismaEditorialSaveWriter } from './infrastructure/prisma-editorial-save-writer';
import { EDITORIAL_INITIALIZE_WRITER } from './application/editorial-initialize-writer';
import { PrismaEditorialInitializeWriter } from './infrastructure/prisma-editorial-initialize-writer';
import { EDITORIAL_DISCARD_WRITER } from './application/editorial-discard-writer';
import { PrismaEditorialDiscardWriter } from './infrastructure/prisma-editorial-discard-writer';
import { EDITORIAL_DOCUMENT_READER } from './application/editorial-document-reader';
import { PrismaEditorialDocumentReader } from './infrastructure/prisma-editorial-document-reader';
import { EDITORIAL_READINESS_READER } from './application/editorial-readiness-reader';
import { PrismaEditorialReadinessReader } from './infrastructure/prisma-editorial-readiness-reader';
import { EditorialHttpScope } from './infrastructure/editorial-http-scope';
import { createCoordinatedEditorialWriteAuthority } from './infrastructure/prisma-coordinated-editorial-authority';
import { EditorialWriteController } from './http/editorial-write.controller';
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
  controllers: [EditorialReadController, EditorialWriteController],
  providers: [
    JwtAuthGuard,
    TenantContextGuard,
    {
      provide: EditorialHttpScope,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new EditorialHttpScope(prisma),
    },
    {
      provide: PrismaEditorialAuthority,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaEditorialAuthority(prisma),
    },
    {
      provide: EDITORIAL_DOCUMENT_READER,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaEditorialDocumentReader(prisma),
    },
    {
      provide: EDITORIAL_READINESS_READER,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaEditorialReadinessReader(prisma),
    },
    {
      provide: EDITORIAL_DISCARD_WRITER,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaEditorialDiscardWriter(prisma),
    },
    {
      provide: EDITORIAL_INITIALIZE_WRITER,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaEditorialInitializeWriter(prisma),
    },
    {
      provide: EDITORIAL_SAVE_WRITER,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaEditorialSaveWriter(prisma),
    },
    {
      provide: EDITORIAL_READER,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaCatalogEditorial(
          prisma,
          new PrismaEditorialAuthority(prisma),
          undefined,
          undefined,
          createCoordinatedEditorialWriteAuthority,
        ),
    },
  ],
})
export class CatalogEditorialReadModule {}
