/**
 * cash-register-closing / S10 — count, declare, annotate and verify (S4, S2).
 *
 * Freeze the operational movements before physical counting, persist the
 * first blind declaration UNCHANGED before any expected-dependent comparison,
 * append later explanation revisions immutably, and keep verification
 * independent of the declarant.
 */
import {
  CASH_RULE_CODES,
  assertCanFreezeSession,
  assertIndependentVerifier,
  assertNonEmptyText,
  cashRuleViolation,
  compareCashCounts,
  projectCashSession,
  validateCashCount,
} from '../domain';
import {
  CASH_AUDIT_REQUIREMENT,
  canInstanceAbility,
} from '../application/cash-authorization';
import {
  CASH_APPLICATION_CODES,
  cashAppError,
} from '../application/cash-application.errors';
import type {
  CashActor,
  CashCommand,
  CashDocument,
} from '../cash-application.port';
import {
  decodeCountLines,
  decodeDenominations,
  decodeExpectedSnapshot,
} from './cash-json';
import {
  assertChannelExplanations,
  buildExpectedSnapshot,
  cashCents,
  compareSafely,
} from './cash-adapter-count-rules';
import type { TenantClient } from './cash-adapter-client';
import {
  assertCommandAbility,
  sessionInstance,
} from './cash-adapter-instances';
import { toDomainSession } from './cash-adapter-mappers';
import {
  assertSessionOwner,
  latestCount,
  loadSessionMovements,
  requireSessionLocked,
} from './cash-adapter-storage';
import { type CountCommand, document, prismaJson } from './cash-adapter-values';

export async function startCount(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  sessionId: string,
): Promise<CashDocument> {
  const session = await requireSessionLocked(tx, tenantId, sessionId);
  assertCommandAbility(actor, 'START_COUNT', sessionInstance(session));
  assertSessionOwner(session, actor.userId);
  const domain = toDomainSession(session);
  assertCanFreezeSession(domain);
  const movements = await loadSessionMovements(tx, tenantId, session.id);
  const now = new Date();
  const frozen = buildExpectedSnapshot(session.openingCents, movements, now);
  await tx.cashSession.update({
    where: { id: session.id },
    data: {
      status: 'COUNTING',
      frozenAt: now,
      expectedJson: prismaJson(frozen),
    },
  });
  const projection = projectCashSession({
    session: { ...domain, status: 'COUNTING', frozenAt: now },
    viewerUserId: actor.userId,
    expectedCashCents: frozen.cashExpectedCents,
    declaredCents: null,
    hasAuditVisibility: canInstanceAbility(
      actor,
      CASH_AUDIT_REQUIREMENT,
      sessionInstance(session),
    ),
    declarationSubmitted: false,
  });
  return document({ session: projection });
}

export async function declare(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  command: CountCommand,
): Promise<CashDocument> {
  const session = await requireSessionLocked(tx, tenantId, command.sessionId);
  assertCommandAbility(actor, 'DECLARE', sessionInstance(session));
  assertSessionOwner(session, actor.userId);
  if (session.status !== 'COUNTING' || session.expectedJson === null) {
    throw cashRuleViolation(
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
      'A declaration requires a frozen counting session',
      { sessionId: session.id, status: session.status },
    );
  }
  const expected = decodeExpectedSnapshot(session.expectedJson);
  if (!expected) {
    throw cashRuleViolation(
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
      'Expected snapshot is missing for a counting session',
      { sessionId: session.id },
    );
  }
  const existing = await tx.cashCount.findFirst({
    where: { tenantId, sessionId: session.id, kind: 'DECLARATION' },
  });
  if (existing) {
    throw cashAppError(
      CASH_APPLICATION_CODES.DECLARATION_ALREADY_SUBMITTED,
      'This session already has a blind declaration',
      { sessionId: session.id },
    );
  }
  const required = expected.channels.map((channel) => channel.channelKey);
  const validated = validateCashCount({
    lines: command.lines,
    requiredChannelKeys: required,
    denominations: command.denominations ?? null,
  });
  const notes = command.notes ?? null;
  // Persist the first blind declaration UNCHANGED before any
  // expected-dependent comparison. A mismatch must never roll it back.
  await tx.cashCount.create({
    data: {
      tenantId,
      sessionId: session.id,
      kind: 'DECLARATION',
      revision: 1,
      actorUserId: actor.userId,
      linesJson: prismaJson(validated.lines),
      denominationsJson: prismaJson(command.denominations ?? null),
      notes,
    },
  });
  await tx.cashSession.update({
    where: { id: session.id },
    data: { status: 'SUBMITTED', submittedAt: new Date() },
  });
  const comparison = compareSafely({
    expectedCents: expected.cashExpectedCents,
    declaredCents: validated.cashCents,
    verifiedCents: null,
    declarationNotes: notes,
    verificationNotes: null,
  });
  return document({
    sessionId: session.id,
    status: 'SUBMITTED',
    declaration: {
      revision: 1,
      lines: validated.lines,
      denominations: command.denominations ?? null,
      notes,
      cashCents: validated.cashCents,
    },
    comparison: comparison,
  });
}

export async function annotateDeclaration(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  command: Extract<CashCommand, { kind: 'ANNOTATE_DECLARATION' }>,
): Promise<CashDocument> {
  const session = await requireSessionLocked(tx, tenantId, command.sessionId);
  assertCommandAbility(actor, 'ANNOTATE_DECLARATION', sessionInstance(session));
  assertSessionOwner(session, actor.userId);
  const verification = await tx.cashCount.findFirst({
    where: { tenantId, sessionId: session.id, kind: 'VERIFICATION' },
  });
  if (verification || session.status === 'CLOSED') {
    throw cashAppError(
      CASH_APPLICATION_CODES.ANNOTATION_BLOCKED,
      'Declaration notes cannot change after verification or closing',
      { sessionId: session.id },
    );
  }
  const declaration = await latestCount(
    tx,
    tenantId,
    session.id,
    'DECLARATION',
  );
  if (!declaration) {
    throw cashAppError(
      CASH_APPLICATION_CODES.DECLARATION_NOT_FOUND,
      'No declaration exists to annotate',
      { sessionId: session.id },
    );
  }
  const notes = assertNonEmptyText(command.notes, 'notes');
  const lines = decodeCountLines(declaration.linesJson);
  const denominations = decodeDenominations(declaration.denominationsJson);
  const revision = declaration.revision + 1;
  await tx.cashCount.create({
    data: {
      tenantId,
      sessionId: session.id,
      kind: 'DECLARATION',
      revision,
      actorUserId: actor.userId,
      linesJson: prismaJson(lines),
      denominationsJson: prismaJson(denominations ?? null),
      notes,
    },
  });
  return document({
    sessionId: session.id,
    revision,
    lines: lines,
    denominations: denominations ?? null,
    notes,
  });
}

export async function verify(
  tx: TenantClient,
  tenantId: string,
  actor: CashActor,
  command: CountCommand,
): Promise<CashDocument> {
  const session = await requireSessionLocked(tx, tenantId, command.sessionId);
  assertCommandAbility(actor, 'VERIFY', sessionInstance(session));
  if (session.status !== 'SUBMITTED') {
    throw cashRuleViolation(
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
      'Verification requires a submitted declaration',
      { sessionId: session.id, status: session.status },
    );
  }
  assertIndependentVerifier({
    cashierUserId: session.cashierUserId,
    verifierUserId: actor.userId,
  });
  const expected = decodeExpectedSnapshot(session.expectedJson);
  if (!expected) {
    throw cashRuleViolation(
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
      'Expected snapshot is missing for verification',
      { sessionId: session.id },
    );
  }
  const declaration = await latestCount(
    tx,
    tenantId,
    session.id,
    'DECLARATION',
  );
  if (!declaration) {
    throw cashAppError(
      CASH_APPLICATION_CODES.DECLARATION_NOT_FOUND,
      'No declaration exists to verify',
      { sessionId: session.id },
    );
  }
  const existingVerification = await tx.cashCount.findFirst({
    where: { tenantId, sessionId: session.id, kind: 'VERIFICATION' },
  });
  if (existingVerification) {
    throw cashAppError(
      CASH_APPLICATION_CODES.ALREADY_VERIFIED,
      'This session already has an independent verification',
      { sessionId: session.id },
    );
  }
  const required = expected.channels.map((channel) => channel.channelKey);
  const validated = validateCashCount({
    lines: command.lines,
    requiredChannelKeys: required,
    denominations: command.denominations ?? null,
  });
  const declarationLines = decodeCountLines(declaration.linesJson);
  assertChannelExplanations(
    expected,
    declarationLines,
    validated.lines,
    declaration.notes,
    command.notes ?? null,
  );
  const declaredCash = cashCents(declarationLines);
  // Require the explanation BEFORE writing the verification: a missing
  // declaration/verification note blocks the independent step without ever
  // touching the preserved declaration.
  const comparison = compareCashCounts({
    expectedCents: expected.cashExpectedCents,
    declaredCents: declaredCash,
    verifiedCents: validated.cashCents,
    declarationNotes: declaration.notes,
    verificationNotes: command.notes ?? null,
  });
  await tx.cashCount.create({
    data: {
      tenantId,
      sessionId: session.id,
      kind: 'VERIFICATION',
      revision: 1,
      actorUserId: actor.userId,
      linesJson: prismaJson(validated.lines),
      denominationsJson: prismaJson(command.denominations ?? null),
      notes: command.notes ?? null,
    },
  });
  return document({
    sessionId: session.id,
    verification: {
      revision: 1,
      actorUserId: actor.userId,
      lines: validated.lines,
      denominations: command.denominations ?? null,
      notes: command.notes ?? null,
      cashCents: validated.cashCents,
    },
    comparison: comparison,
  });
}
