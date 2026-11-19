import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatbotRequestWrapperModule } from '../chatbot-requests/chatbot-request-wrapper.module';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationConfigModule } from '../notification-config/notification-config.module';
import { OutboxModule } from '../shared/outbox/outbox.module';
import { createSpacesClient } from '../files/infrastructure/spaces-client.factory';
import { ReceiptUploadService } from './application/receipt-upload.service';
import { ReceiptFileService } from './application/receipt-file.service';
import { ReceiptStatusService } from './application/receipt-status.service';
import { ReceiptRetentionService } from './application/receipt-retention.service';
import { ReceiptFileController } from './presentation/receipt-file.controller';
import {
  RECEIPT_PREVIEW_RASTERIZER,
  RECEIPT_STORAGE,
} from './domain/receipt-storage.port';
import { PdfiumPreviewRasterizer } from './infrastructure/pdfium-preview-rasterizer';
import { SpacesReceiptStorageAdapter } from './infrastructure/spaces-receipt-storage.adapter';
import { RECEIPT_REVIEWER_LOOKUP } from './domain/receipt-reviewer-lookup.port';
import { PrismaReceiptReviewerLookup } from './infrastructure/prisma-receipt-reviewer.lookup';

/**
 * Receipt evidence storage. Reuses the SPACES_* client configuration of
 * `src/files`, but every object is written with a private ACL. Set
 * RECEIPTS_SPACES_BUCKET to keep receipts in a separate bucket; it defaults
 * to SPACES_BUCKET. Staff read the files only through ReceiptFileController
 * (JWT + tenant + read ReceiptEvidence), streamed by the backend.
 */
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    NotificationConfigModule,
    OutboxModule,
    ChatbotRequestWrapperModule,
  ],
  controllers: [ReceiptFileController],
  providers: [
    ReceiptUploadService,
    ReceiptFileService,
    ReceiptStatusService,
    ReceiptRetentionService,
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
    { provide: RECEIPT_REVIEWER_LOOKUP, useClass: PrismaReceiptReviewerLookup },
    {
      provide: RECEIPT_PREVIEW_RASTERIZER,
      useFactory: () => new PdfiumPreviewRasterizer(),
    },
  ],
  exports: [
    ReceiptUploadService,
    ReceiptStatusService,
    ReceiptRetentionService,
    RECEIPT_REVIEWER_LOOKUP,
  ],
})
export class ReceiptsModule {}
