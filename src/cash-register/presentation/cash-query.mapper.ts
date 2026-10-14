/**
 * QUERY MAPPER: cash-register presentation (T3/S3,S7).
 *
 * Projects the validated list query DTO onto the port's `CashPageInput`,
 * forwarding optional filters only when the client supplied them so the
 * application can apply its own defaults. The tenant is never part of this
 * shape — the application derives it from the actor.
 */
import type { CashPageInput } from '../cash-application.port';
import type { CashListQueryDto } from './dto/query.dto';

export function toCashPageInput(query: CashListQueryDto): CashPageInput {
  return {
    page: query.page,
    limit: query.limit,
    ...(query.registerId !== undefined ? { registerId: query.registerId } : {}),
    ...(query.cashierUserId !== undefined
      ? { cashierUserId: query.cashierUserId }
      : {}),
    ...(query.from !== undefined ? { from: query.from } : {}),
    ...(query.to !== undefined ? { to: query.to } : {}),
  };
}
