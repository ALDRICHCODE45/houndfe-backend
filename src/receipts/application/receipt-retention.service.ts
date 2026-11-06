import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  RECEIPT_STORAGE,
  type ReceiptStoragePort,
} from '../domain/receipt-storage.port';

/** Stored receipt files are kept 5 years from upload, then deleted. */
export const RECEIPT_RETENTION_YEARS = 5;
const DEFAULT_BATCH_SIZE = 100;

export type ReceiptRetentionResult = {
  scanned: number;
  purged: number;
  failed: number;
};

/**
 * Deletes the private objects (original + preview) of receipts older than
 * the retention period and marks the row purged: `purgedAt` set, storage
 * keys cleared. The row, its amounts and its review outcome stay for
 * accounting.
 *
 * Runs outside any request, so it reads through the GLOBAL PrismaService
 * across tenants. Tenant safety comes from the key layout: a key is deleted
 * only when it lives under `receipts/<row tenant>/`, and the row update is
 * qualified by id + tenant + `purgedAt IS NULL`. A failed delete keeps the
 * keys, so the next run retries; deleting an already missing object
 * succeeds, so reruns are idempotent.
 *
 * A failure (delete error or key outside the prefix) bumps `purgeAttempts`
 * and stamps `lastPurgeErrorAt = now`. Batches of the same run (same `now`)
 * skip those rows, and later runs scan them after the rows never tried, so
 * rows that keep failing cannot starve newer due rows.
 */
@Injectable()
export class ReceiptRetentionService {
  private readonly logger = new Logger(ReceiptRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStoragePort,
  ) {}

  async purgeBatch(input: {
    now: Date;
    batchSize?: number;
    dryRun?: boolean;
  }): Promise<ReceiptRetentionResult> {
    const cutoff = new Date(input.now);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - RECEIPT_RETENTION_YEARS);

    const candidates = await this.prisma.receiptEvidence.findMany({
      where: {
        purgedAt: null,
        storageKey: { not: null },
        createdAt: { lt: cutoff },
        OR: [
          { lastPurgeErrorAt: null },
          { lastPurgeErrorAt: { lt: input.now } },
        ],
      },
      orderBy: [{ purgeAttempts: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: input.batchSize ?? DEFAULT_BATCH_SIZE,
      select: { id: true, tenantId: true, storageKey: true, previewKey: true },
    });

    const result: ReceiptRetentionResult = {
      scanned: candidates.length,
      purged: 0,
      failed: 0,
    };
    if (input.dryRun) return result;

    for (const receipt of candidates) {
      const keys = [
        ...new Set([receipt.storageKey, receipt.previewKey]),
      ].filter((key): key is string => Boolean(key));
      const prefix = `receipts/${receipt.tenantId}/`;
      if (keys.some((key) => !key.startsWith(prefix))) {
        this.logger.error(
          `Receipt ${receipt.id} has a key outside its tenant prefix; not purged`,
        );
        await this.recordFailure(receipt, input.now);
        result.failed += 1;
        continue;
      }

      try {
        for (const key of keys) {
          await this.storage.remove(key);
        }
      } catch (error) {
        this.logger.warn(
          `Receipt ${receipt.id} purge failed, will retry: ${(error as Error).message}`,
        );
        await this.recordFailure(receipt, input.now);
        result.failed += 1;
        continue;
      }

      const { count } = await this.prisma.receiptEvidence.updateMany({
        where: { id: receipt.id, tenantId: receipt.tenantId, purgedAt: null },
        data: { purgedAt: input.now, storageKey: null, previewKey: null },
      });
      result.purged += count;
    }

    if (result.purged > 0 || result.failed > 0) {
      this.logger.log(
        `Receipt retention: scanned=${result.scanned} purged=${result.purged} failed=${result.failed}`,
      );
    }
    return result;
  }

  private async recordFailure(
    receipt: { id: string; tenantId: string },
    now: Date,
  ): Promise<void> {
    await this.prisma.receiptEvidence.updateMany({
      where: { id: receipt.id, tenantId: receipt.tenantId, purgedAt: null },
      data: { purgeAttempts: { increment: 1 }, lastPurgeErrorAt: now },
    });
  }
}
