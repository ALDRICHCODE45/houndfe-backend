/**
 * DOMAIN POLICY: cash-register session lifecycle and blind projection
 * (T1/S2,S4,S5,S8).
 *
 * Lifecycle is strictly forward: OPEN -> COUNTING (freeze) -> SUBMITTED
 * (declaration) -> CLOSED (verified close). Freezing fences every
 * operational money write; the physical drawer release is a separate event
 * modelled by the handover policy, never by a status change.
 *
 * `projectCashSession` is the only blindness rule in the domain: it strips
 * expected/difference from a declarant's own pre-submission projection even
 * when the caller holds audit visibility. It makes no claim about other
 * endpoints (existing sales visibility may still allow inference).
 */
import { assertStorageRangeCents, subtractCents } from './cash-money';
import { CASH_RULE_CODES, cashRuleViolation } from './cash-register.errors';
import type { CashSession, CashSessionStatus } from './cash-register.types';
import { assertNonEmptyText } from './cash-guards';

export const CASH_STATUS_TRANSITIONS: Readonly<
  Record<CashSessionStatus, readonly CashSessionStatus[]>
> = {
  OPEN: ['COUNTING'],
  COUNTING: ['SUBMITTED'],
  SUBMITTED: ['CLOSED'],
  CLOSED: [],
};

export function canTransitionStatus(
  from: CashSessionStatus,
  to: CashSessionStatus,
): boolean {
  return CASH_STATUS_TRANSITIONS[from].includes(to);
}

export function assertValidStatusTransition(
  from: CashSessionStatus,
  to: CashSessionStatus,
): void {
  if (!canTransitionStatus(from, to)) {
    throw cashRuleViolation(
      CASH_RULE_CODES.INVALID_STATUS_TRANSITION,
      `Invalid cash session transition ${from} -> ${to}`,
      { from, to },
    );
  }
}

/** Frozen = physical counting started; operational writes must stop. */
export function isFrozen(session: CashSession): boolean {
  return session.status !== 'OPEN' || session.frozenAt !== null;
}

export function assertOperationalWriteAllowed(session: CashSession): void {
  if (isFrozen(session)) {
    throw cashRuleViolation(
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
      'Cash session no longer accepts operational movements',
      {
        sessionId: session.id,
        status: session.status,
        frozenAt: session.frozenAt ? session.frozenAt.toISOString() : null,
      },
    );
  }
}

export function assertCanFreezeSession(session: CashSession): void {
  if (session.status !== 'OPEN' || session.frozenAt !== null) {
    throw cashRuleViolation(
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
      'Cash session can only be frozen once from OPEN',
      {
        sessionId: session.id,
        status: session.status,
        frozenAt: session.frozenAt ? session.frozenAt.toISOString() : null,
      },
    );
  }
}

export function assertIndependentVerifier(input: {
  readonly cashierUserId: string;
  readonly verifierUserId: string;
}): void {
  if (input.cashierUserId === input.verifierUserId) {
    throw cashRuleViolation(
      CASH_RULE_CODES.SELF_VERIFICATION_FORBIDDEN,
      'A cashier cannot verify their own declaration',
      { cashierUserId: input.cashierUserId },
    );
  }
}

export function assertIndependentCloser(input: {
  readonly cashierUserId: string;
  readonly closerUserId: string;
}): void {
  if (input.cashierUserId === input.closerUserId) {
    throw cashRuleViolation(
      CASH_RULE_CODES.SELF_CLOSING_FORBIDDEN,
      'A cashier cannot close their own session',
      { cashierUserId: input.cashierUserId },
    );
  }
}

/** Cross-tenant references fail closed before any state is touched. */
export function assertSessionTenant(input: {
  readonly session: CashSession;
  readonly tenantId: string;
}): void {
  if (input.session.tenantId !== input.tenantId) {
    throw cashRuleViolation(
      CASH_RULE_CODES.TENANT_MISMATCH,
      'Cash session does not belong to the active tenant',
      { sessionId: input.session.id, tenantId: input.tenantId },
    );
  }
}

/**
 * The blind-count window is the first declaration revision. Any later
 * revision/recount happens after expected values are revealed and is not a
 * new blind count.
 */
export function isFirstDeclarationRevision(revision: number): boolean {
  return revision === 1;
}

export interface CashSessionProjectionInput {
  readonly session: CashSession;
  readonly viewerUserId: string;
  readonly expectedCashCents: number;
  readonly declaredCents: number | null;
  readonly hasAuditVisibility: boolean;
  readonly declarationSubmitted: boolean;
}

export interface CashSessionProjectionView {
  readonly id: string;
  readonly tenantId: string;
  readonly registerId: string;
  readonly status: CashSessionStatus;
  readonly cashierUserId: string;
  readonly openingCents: number;
  readonly frozenAt: string | null;
  readonly drawerReleasedAt: string | null;
  readonly blind: boolean;
  readonly expectedCashCents?: number;
  readonly differenceCents?: number;
}

/**
 * Session read projection. Expected/difference are absent (not null) when
 * hidden, so a consumer cannot mistake "hidden" for "zero".
 */
export function projectCashSession(
  input: CashSessionProjectionInput,
): CashSessionProjectionView {
  assertNonEmptyText(input.viewerUserId, 'viewerUserId');
  assertStorageRangeCents(input.expectedCashCents, 'expectedCashCents');
  if (input.declaredCents !== null) {
    assertStorageRangeCents(input.declaredCents, 'declaredCents');
  }
  const session = input.session;
  const isDeclarant = input.viewerUserId === session.cashierUserId;
  const blind = isDeclarant && !input.declarationSubmitted;
  const canSeeExpected = !blind && (isDeclarant || input.hasAuditVisibility);
  const base: CashSessionProjectionView = {
    id: session.id,
    tenantId: session.tenantId,
    registerId: session.registerId,
    status: session.status,
    cashierUserId: session.cashierUserId,
    openingCents: session.openingCents,
    frozenAt: session.frozenAt ? session.frozenAt.toISOString() : null,
    drawerReleasedAt: session.drawerReleasedAt
      ? session.drawerReleasedAt.toISOString()
      : null,
    blind,
  };
  if (!canSeeExpected) {
    return base;
  }
  const differenceCents =
    input.declaredCents === null
      ? null
      : subtractCents(
          input.declaredCents,
          input.expectedCashCents,
          'differenceCents',
        );
  return {
    ...base,
    expectedCashCents: input.expectedCashCents,
    ...(differenceCents === null ? {} : { differenceCents }),
  };
}
