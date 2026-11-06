import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { ReceiptReadError } from '../domain/receipt-read.errors';
import {
  RECEIPT_STORAGE,
  type ReceiptStoragePort,
} from '../domain/receipt-storage.port';

export type ReceiptFileVariant = 'original' | 'preview';

export type ReceiptFileStream = {
  body: Readable;
  mimeType: string;
  contentLength: number | null;
  filename: string;
};

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

/**
 * Staff read path for privately stored receipts. The bytes are streamed
 * through the backend after the tenant-scoped lookup; Spaces is never
 * exposed and no URL is ever signed.
 */
@Injectable()
export class ReceiptFileService {
  private readonly logger = new Logger(ReceiptFileService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStoragePort,
  ) {}

  async open(
    saleId: string,
    receiptId: string,
    variant: ReceiptFileVariant,
  ): Promise<ReceiptFileStream> {
    const tenantId = this.tenantPrisma.getTenantId();
    const row = await this.tenantPrisma.getClient().receiptEvidence.findFirst({
      where: { id: receiptId, saleId, tenantId },
      select: {
        storageKey: true,
        mimeType: true,
        previewKey: true,
        previewMimeType: true,
        purgedAt: true,
      },
    });
    if (!row) {
      throw new ReceiptReadError('RECEIPT_NOT_FOUND', 'Receipt not found');
    }
    if (row.purgedAt) {
      throw new ReceiptReadError(
        'RECEIPT_FILE_PURGED',
        'Receipt file was deleted by the retention policy',
      );
    }

    const key = variant === 'original' ? row.storageKey : row.previewKey;
    const mimeType =
      variant === 'original' ? row.mimeType : row.previewMimeType;
    if (!key || !mimeType) throw notAvailable();

    let object: Awaited<ReturnType<ReceiptStoragePort['getPrivate']>>;
    try {
      object = await this.storage.getPrivate(key);
    } catch (error) {
      this.logger.error(
        `Receipt object read failed for ${receiptId}: ${(error as Error).message}`,
      );
      throw new ReceiptReadError(
        'RECEIPT_STORAGE_FAILED',
        'Receipt file could not be read, retry later',
      );
    }
    if (!object) throw notAvailable();

    const extension = EXTENSIONS[mimeType] ?? 'bin';
    const suffix = variant === 'preview' ? '-vista-previa' : '';
    return {
      body: object.body,
      mimeType,
      contentLength: object.contentLength,
      // Only the receipt UUID and a fixed extension: safe in a header.
      filename: `comprobante-${receiptId}${suffix}.${extension}`,
    };
  }
}

function notAvailable(): ReceiptReadError {
  return new ReceiptReadError(
    'RECEIPT_FILE_NOT_AVAILABLE',
    'Receipt has no stored file for this view',
  );
}
