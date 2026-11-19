import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { BusinessRuleViolationError } from '../shared/domain/domain-error';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import {
  SALE_REPOSITORY,
  type ISaleRepository,
} from './domain/sale.repository';
import type { SaleDetailResponseDto } from './dto/sale-detail-response.dto';
import {
  SaleHoldSweepStore,
  type ManualExpiryOutcome,
} from './sale-hold-sweep.store';
import { SalesService } from './sales.service';

/** Response of POST /sales/:id/hold/expire: the sale detail plus the outcome. */
export type ExpireSaleHoldResponse = SaleDetailResponseDto & {
  outcome: ManualExpiryOutcome;
};

/**
 * pay-in-store-pickup / T6 (S10, S11) — «Vencer apartado ahora».
 *
 * One tenant transaction: the idempotency slot (`sale_hold_expire`, acquired
 * conflict-safe inside the transaction), the sweep's expiry step for the
 * sale (`SaleHoldSweepStore.expireNow`, row lock + checks + `planHoldStep` +
 * effects), the sale detail read on the same transaction, and the stored
 * response. Any rejection rolls the slot back, so a retry with the same key
 * re-evaluates; a success replays the first response byte for byte.
 *
 * The request hash binds sale, actor and `expectedVersion`: the same key from
 * another user or with another version is IDEMPOTENCY_KEY_CONFLICT.
 */
@Injectable()
export class SaleHoldExpireService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @Inject(SALE_REPOSITORY) private readonly saleRepo: ISaleRepository,
    private readonly sweep: SaleHoldSweepStore,
    private readonly sales: SalesService,
  ) {}

  expireNow(
    saleId: string,
    actorUserId: string,
    input: { expectedVersion: number },
    idempotencyKey: string,
    now: Date = new Date(),
  ): Promise<ExpireSaleHoldResponse> {
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          saleId,
          actorUserId,
          expectedVersion: input.expectedVersion,
        }),
      )
      .digest('hex');

    return this.tenantPrisma.runInTransaction(async () => {
      const idempotency = await this.saleRepo.acquireHoldExpireIdempotency(
        idempotencyKey,
        requestHash,
      );
      if (idempotency.kind === 'replay') {
        return idempotency.payload as ExpireSaleHoldResponse;
      }
      if (idempotency.kind === 'conflict') {
        throw new BusinessRuleViolationError(
          'IDEMPOTENCY_KEY_CONFLICT',
          'IDEMPOTENCY_KEY_CONFLICT',
        );
      }
      if (idempotency.kind === 'in_flight') {
        throw new BusinessRuleViolationError(
          'IDEMPOTENCY_KEY_IN_FLIGHT',
          'IDEMPOTENCY_KEY_IN_FLIGHT',
        );
      }

      const outcome = await this.sweep.expireNow(
        saleId,
        actorUserId,
        input.expectedVersion,
        now,
      );
      const detail = await this.sales.getSaleDetail(saleId);
      // Stored as JSON, so the first response and a replay are identical.
      const payload = JSON.parse(
        JSON.stringify({ ...detail, outcome }),
      ) as ExpireSaleHoldResponse;
      await this.saleRepo.markHoldExpireIdempotencySucceeded(
        idempotency.token,
        saleId,
        payload,
      );
      return payload;
    });
  }
}
