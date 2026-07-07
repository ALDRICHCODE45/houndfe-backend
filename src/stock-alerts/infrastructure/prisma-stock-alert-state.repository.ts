/**
 * ADAPTER: PrismaStockAlertStateRepository.
 *
 * Concrete implementation of `IStockAlertStateRepository` over raw SQL.
 *
 * Critical contract:
 *   - `seedAndFlip` runs TWO raw statements inside the SAME transaction
 *     that performed the decrement + the outbox write:
 *       1. `INSERT ... ON CONFLICT DO NOTHING` to ensure an armed row
 *          exists for `(tenantId, productId, variantKey)`.
 *       2. `UPDATE ... RETURNING "alertEpoch"` guarded by
 *          `alerted = false`. Count === 1 ⇒ this tx owns the crossing.
 *   - `rearm` is an unguarded `UPDATE` setting `alerted = false`. The
 *     STRICT `newQuantity > minQuantity` precondition is enforced at
 *     the caller (the columns live on the product/variant, not on
 *     `stock_alert_states`).
 *
 * **Why raw SQL?** Prisma Client cannot RETURNING from updateMany, so
 * `$queryRaw` is required to read `alertEpoch` atomically with the
 * flip. Raw SQL also bypasses the tenant-id extension — every statement
 * carries `"tenantId" = $N` explicitly (carried gate, design §Security
 * & Isolation, finding #3).
 *
 * **Isolation**: READ COMMITTED. The design pins this explicitly
 * (finding #11) and forbids raising it for this path: REPEATABLE READ
 * / SERIALIZABLE would surface a Prisma `P2034` on the losing
 * concurrent tx instead of a clean `count === 0`. The connection
 * default is sufficient; `runInTransaction` does not override it.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { IStockAlertStateRepository } from '../domain/stock-alert-state.repository';

type TxClient = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

@Injectable()
export class PrismaStockAlertStateRepository
  implements IStockAlertStateRepository
{
  async seedAndFlip(input: {
    tx: unknown;
    tenantId: string;
    productId: string;
    variantId: string | null;
  }): Promise<number | null> {
    const tx = input.tx as TxClient;
    const variantKey = input.variantId ?? '__PRODUCT__';
    const newId = randomUUID();

    // 1. Ensure an armed row exists. Idempotent via ON CONFLICT
    //    (unique key: [tenantId, productId, variantKey]).
    //
    //    Both `"createdAt"` and `"updatedAt"` MUST be supplied:
    //      - `createdAt` has a DB default of `CURRENT_TIMESTAMP`, so omitting
    //        it is fine — but supplying it makes the SQL self-describing and
    //        matches the explicit values declared in the migration.
    //      - `updatedAt` has NO DB default and is `NOT NULL`. On the FIRST
    //        crossing for any (tenantId, productId, variantKey) the row does
    //        NOT exist, the INSERT actually executes, and omitting the
    //        column aborts the whole sale transaction with `23502`. The
    //        `@updatedAt` directive on the Prisma model is Client-applied,
    //        but `$queryRaw` bypasses Prisma Client — we have to set the
    //        value explicitly via SQL `NOW()`. See
    //        `prisma-stock-alert-state.repository.integration.spec.ts`.
    await tx.$queryRaw`
      INSERT INTO "stock_alert_states"
        ("id", "tenantId", "productId", "variantId", "variantKey", "alerted", "alertEpoch", "createdAt", "updatedAt")
      VALUES
        (${newId}, ${input.tenantId}, ${input.productId}, ${input.variantId}, ${variantKey}, false, 0, NOW(), NOW())
      ON CONFLICT ("tenantId", "productId", "variantKey") DO NOTHING
    `;

    // 2. Conditional arm→alert flip. UPDATE ... RETURNING yields
    //    zero rows when another tx already flipped (and committed) the
    //    same key — caller treats null as "not new".
    const rows = (await tx.$queryRaw`
      UPDATE "stock_alert_states"
         SET "alerted" = true,
             "alertEpoch" = "alertEpoch" + 1,
             "alertedAt" = NOW(),
             "updatedAt" = NOW()
       WHERE "tenantId" = ${input.tenantId}
         AND "productId" = ${input.productId}
         AND "variantKey" = ${variantKey}
         AND "alerted" = false
      RETURNING "alertEpoch"::int AS "alertEpoch"
    `) as Array<{ alertEpoch: number }>;

    if (rows.length !== 1) {
      return null;
    }
    return rows[0].alertEpoch;
  }

  async rearm(input: {
    tx: unknown;
    tenantId: string;
    productId: string;
    variantId: string | null;
  }): Promise<number> {
    const tx = input.tx as TxClient;
    const variantKey = input.variantId ?? '__PRODUCT__';

    const rows = (await tx.$queryRaw`
      UPDATE "stock_alert_states"
         SET "alerted" = false,
             "updatedAt" = NOW()
       WHERE "tenantId" = ${input.tenantId}
         AND "productId" = ${input.productId}
         AND "variantKey" = ${variantKey}
      RETURNING "alertEpoch"::int AS "alertEpoch"
    `) as Array<{ alertEpoch: number }>;

    return rows.length;
  }
}