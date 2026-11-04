import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { LowStockCrossing } from '../../stock-alerts/infrastructure/low-stock-crossing.service';
import {
  InsufficientStockError,
  StockBucketNotFoundError,
  StockNotTrackedError,
  StockVersionConflictError,
} from '../domain/stock-journal.errors';
import type { StockBucketRef } from '../domain/stock-journal.types';
import { StockJournalWriter } from '../infrastructure/stock-journal.writer';
import {
  requireInventoryAuthority,
  resolveInventoryPrincipal,
} from './inventory-authority';
import {
  hashAdjustmentBody,
  InventoryContractError,
  MAX_POSTGRES_INT,
  parseAdjustmentBody,
  parseInventoryIdempotencyKey,
  type AdjustmentInput,
  type AdjustmentResult,
} from './inventory-contract';
import { InventoryStockReader } from './inventory-stock-reader';
import { toMovementView } from './inventory-views';

export interface AdjustmentCommandResult {
  statusCode: 201;
  body: AdjustmentResult;
}

function bucketOf({ target }: AdjustmentInput): StockBucketRef {
  if (target.variantId)
    return {
      kind: 'VARIANT',
      productId: target.productId,
      variantId: target.variantId,
    };
  if (target.lotId)
    return { kind: 'LOT', productId: target.productId, lotId: target.lotId };
  return { kind: 'PRODUCT_UNTRACKED', productId: target.productId };
}

/** Receipt namespace target: the bucket the key was spent on. */
function receiptTarget({ target }: AdjustmentInput): string {
  if (target.variantId) return `VARIANT:${target.variantId}`;
  if (target.lotId) return `LOT:${target.lotId}`;
  return `PRODUCT:${target.productId}`;
}

function translate(error: unknown): never {
  if (error instanceof InventoryContractError) throw error;
  if (error instanceof InsufficientStockError)
    throw new InventoryContractError('INSUFFICIENT_STOCK');
  if (error instanceof StockVersionConflictError)
    throw new InventoryContractError('STOCK_VERSION_CONFLICT');
  if (error instanceof StockNotTrackedError)
    throw new InventoryContractError('STOCK_NOT_TRACKED');
  if (error instanceof StockBucketNotFoundError)
    throw new InventoryContractError('NOT_FOUND');
  throw new InventoryContractError('INTERNAL_ERROR');
}

/** CLS principal only; HTTP owns raw duplicate-key/header checks and no-store. */
@Injectable()
export class InventoryCommands {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly writer: StockJournalWriter,
    private readonly stock: InventoryStockReader,
    private readonly crossing: LowStockCrossing,
  ) {}

  async adjust(
    rawKey: unknown,
    body: unknown,
  ): Promise<AdjustmentCommandResult> {
    try {
      return await this.execute(rawKey, parseAdjustmentBody(body));
    } catch (error) {
      return translate(error);
    }
  }

  private async execute(
    rawKey: unknown,
    input: AdjustmentInput,
  ): Promise<AdjustmentCommandResult> {
    const idempotencyKey = parseInventoryIdempotencyKey([
      'Idempotency-Key',
      rawKey,
    ]);
    const { actorId, tenantId } = resolveInventoryPrincipal(this.cls, this.db);
    const requestHash = hashAdjustmentBody(input);
    const namespace = {
      tenantId,
      actorId,
      operation: 'ADJUST' as const,
      target: receiptTarget(input),
      idempotencyKey,
    };
    const gate = createHash('sha256')
      .update(
        JSON.stringify([
          'inventory-adjustment-command-v1',
          tenantId,
          actorId,
          namespace.operation,
          namespace.target,
          idempotencyKey,
        ]),
      )
      .digest()
      .readBigInt64BE(0);
    return this.db.runInTransaction(async () => {
      // SAFETY: own runInTransaction supplies the ambient Prisma transaction.
      const tx = this.db.getClient() as unknown as Prisma.TransactionClient;
      const tenants = await tx.$queryRaw<{ id: string; isActive: boolean }[]>(
        Prisma.sql`SELECT t."id", t."isActive" FROM "tenants" t
          WHERE t."id" = ${tenantId} FOR SHARE OF t`,
      );
      if (tenants[0]?.id !== tenantId || tenants[0].isActive !== true)
        throw new InventoryContractError('FORBIDDEN');
      const actor = await requireInventoryAuthority(
        tx,
        { tenantId, actorId },
        'ADJUST',
      );
      const gates = await tx.$queryRaw<{ acquired: boolean }[]>(
        Prisma.sql`SELECT pg_try_advisory_xact_lock(${gate}::bigint) AS acquired`,
      );
      if (gates[0]?.acquired !== true)
        throw new InventoryContractError('IDEMPOTENCY_KEY_IN_FLIGHT');

      const db = this.db.getClient();
      const receipt = await db.inventoryAdjustmentReceipt.findFirst({
        where: namespace,
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new InventoryContractError('IDEMPOTENCY_KEY_CONFLICT');
        return {
          statusCode: 201 as const,
          // SAFETY: only this service writes receipts, using full wire snapshots.
          body: structuredClone(
            receipt.responseBody,
          ) as unknown as AdjustmentResult,
        };
      }

      await this.requireTrackedProduct(tx, tenantId, input);
      const groupId = randomUUID();
      const now = new Date();
      const movements = await this.writer.apply(
        [
          {
            bucket: bucketOf(input),
            delta: input.delta,
            expectedVersion: input.expectedVersion,
          },
        ],
        {
          type: 'ADJUSTMENT',
          groupType: 'ADJUSTMENT',
          groupId,
          actor: { id: actorId, displayName: actor.displayName },
          reason: input.reason,
          note: input.note,
        },
        now,
      );
      await this.crossing.record(movements);
      const stored = await db.stockMovement.findFirstOrThrow({
        where: { tenantId, id: movements[0].id },
      });
      const stock = await this.stock.read(
        tenantId,
        input.target.productId,
        now,
      );
      if (!stock) throw new InventoryContractError('INTERNAL_ERROR');
      const body: AdjustmentResult = {
        movement: toMovementView(stored),
        stock,
      };
      await db.inventoryAdjustmentReceipt.create({
        data: {
          ...namespace,
          groupId,
          requestHash,
          statusCode: 201,
          // SAFETY: body is a server-built JSON-serializable wire object.
          responseBody: body as unknown as Prisma.InputJsonObject,
        },
      });
      return { statusCode: 201 as const, body };
    }, Prisma.TransactionIsolationLevel.ReadCommitted);
  }

  /**
   * Locks the product (same order as the writer: product first) and rejects
   * untracked products and quantities that would overflow the INT column.
   */
  private async requireTrackedProduct(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: AdjustmentInput,
  ): Promise<void> {
    const { productId, variantId, lotId } = input.target;
    const products = await tx.$queryRaw<
      { type: string; useStock: boolean; quantity: number }[]
    >(Prisma.sql`SELECT "type", "useStock", "quantity" FROM "products"
      WHERE "id" = ${productId} AND "tenantId" = ${tenantId} FOR UPDATE`);
    const product = products[0];
    if (!product) throw new InventoryContractError('NOT_FOUND');
    if (!product.useStock || product.type === 'SERVICE')
      throw new InventoryContractError('STOCK_NOT_TRACKED');
    // Lots add to the product total; variants own their column.
    const columns: number[] = [];
    if (variantId) {
      const rows = await tx.$queryRaw<{ quantity: number }[]>(
        Prisma.sql`SELECT "quantity" FROM "variants"
          WHERE "id" = ${variantId} AND "productId" = ${productId} AND "tenantId" = ${tenantId}`,
      );
      if (rows[0]) columns.push(rows[0].quantity);
    } else {
      columns.push(product.quantity);
      if (lotId) {
        const rows = await tx.$queryRaw<{ quantity: number }[]>(
          Prisma.sql`SELECT "quantity" FROM "lots"
            WHERE "id" = ${lotId} AND "productId" = ${productId} AND "tenantId" = ${tenantId}`,
        );
        if (rows[0]) columns.push(rows[0].quantity);
      }
    }
    if (columns.some((quantity) => quantity + input.delta > MAX_POSTGRES_INT))
      throw new InventoryContractError('MALFORMED');
  }
}
