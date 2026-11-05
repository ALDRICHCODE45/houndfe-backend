import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { createSpacesClient } from '../files/infrastructure/spaces-client.factory';
import { ReceiptUploadService } from './application/receipt-upload.service';
import {
  RECEIPT_PREVIEW_RASTERIZER,
  RECEIPT_STORAGE,
} from './domain/receipt-storage.port';
import { PdfiumPreviewRasterizer } from './infrastructure/pdfium-preview-rasterizer';
import { SpacesReceiptStorageAdapter } from './infrastructure/spaces-receipt-storage.adapter';

/**
 * Receipt evidence storage. Reuses the SPACES_* client configuration of
 * `src/files`, but every object is written with a private ACL. Set
 * RECEIPTS_SPACES_BUCKET to keep receipts in a separate bucket; it defaults
 * to SPACES_BUCKET.
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    ReceiptUploadService,
    {
      provide: RECEIPT_STORAGE,
      useFactory: (configService: ConfigService) =>
        new SpacesReceiptStorageAdapter(
          createSpacesClient(configService),
          configService.get<string>('RECEIPTS_SPACES_BUCKET') ||
            configService.getOrThrow<string>('SPACES_BUCKET'),
        ),
      inject: [ConfigService],
    },
    {
      provide: RECEIPT_PREVIEW_RASTERIZER,
      useFactory: () => new PdfiumPreviewRasterizer(),
    },
  ],
  exports: [ReceiptUploadService],
})
export class ReceiptsModule {}
