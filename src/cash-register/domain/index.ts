/**
 * PUBLIC DOMAIN API: cash-register closing (T1).
 *
 * Pure, framework-free exports usable by the persistence/application units
 * (T3/T4) without importing Prisma or NestJS.
 *
 * Short integration usage:
 *
 *   // 1. Freeze at counting time, then project the declarant's blind view.
 *   assertCanFreezeSession(session);                       // OPEN -> COUNTING
 *   const view = projectCashSession({
 *     session, viewerUserId, expectedCashCents,
 *     declaredCents: null, hasAuditVisibility: true,
 *     declarationSubmitted: false,                          // blind: no expected
 *   });
 *
 *   // 2. Validate the declaration, then compare it independently AFTER the
 *   //    first declaration is persisted (never before — see "blind" below).
 *   const count = validateCashCount({
 *     lines, requiredChannelKeys: requiredCountChannelKeys(movements),
 *     denominations,
 *   });
 *   const comparison = compareCashCounts({
 *     expectedCents, declaredCents: count.cashCents,
 *     verifiedCents: null, declarationNotes,
 *   });
 *
 *   // 3. Plan POS movements: one tender per payment, one change per sale.
 *   const movements = planChargeMovements({
 *     sessionId, saleId, cashChannel: POOLED_CASH_CHANNEL,
 *     payments, changeDueCents,
 *   });
 *
 *   // 4. Release the drawer only after a fully allocated, actor-bound
 *   //    handover, then freeze a deep-copied cut (ISO timestamps).
 *   assertHandoverReceipt({
 *     kind, declaredCents, receivedCents, senderUserId,
 *     receiverUserId, receiptActorUserId, declaredAt, receivedAt,
 *   });
 *   assertDrawerReleaseAllowed({ session, declaredCountCents, allocations });
 *   const snapshot = createCashClosingSnapshot({
 *     session, folio, verifierUserId, ...totals,
 *   });
 *
 * Blind rule: `projectCashSession` strips expected/difference for a
 * declarant before their own submission (even with audit visibility) and
 * `compareCashCounts` is post-submission only; the application persists the
 * first declaration unchanged, then appends an immutable notes revision.
 */
export * from './cash-register.types';
export * from './cash-register.errors';
export * from './cash-guards';
export * from './cash-money';
export * from './cash-channel';
export * from './cash-session.policy';
export * from './cash-count.policy';
export * from './cash-movement.policy';
export * from './cash-handover.policy';
export * from './cash-snapshot';
