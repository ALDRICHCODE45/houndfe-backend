/**
 * cash-register-closing / S10 — transactional application + ledger facade
 * (S1–S8).
 *
 * One cohesive Prisma-backed provider implements BOTH parent-owned ports:
 *
 *   ICashApplication  — execute(command) / query(query)
 *   ICashLedger       — assertOpenSession / recordPayments / recordRefund
 *
 * The parent binds `CASH_APPLICATION` and `CASH_LEDGER` to this same
 * injectable. The behavior lives in dependency-coherent `cash-adapter-*.ts`
 * modules; this facade owns the transaction, idempotency, command/query
 * dispatch and the ledger ambient-transaction guard.
 *
 * Transaction & lock contract (S8):
 *   - `execute` runs the whole command in ONE ambient transaction: the
 *     idempotency advisory lock, the `CashCommand` lookup/insert and every
 *     money/session write commit together or not at all.
 *   - Lock order is register -> session -> handover. A FLOAT open locks the
 *     source session before the handover row; a receipt locks the source
 *     session before the handover row. `ICashLedger.assertOpenSession` locks
 *     the session before sales/refunds take their own locks.
 *   - Every read/write carries an explicit `tenantId`; cross-tenant rows fail
 *     closed as not-found before details are returned.
 *
 * Blind count (S4): a declarant's own pre-submission session projection never
 * carries expected values, differences or movement deltas — not even with the
 * audit subject. The first declaration is persisted unchanged BEFORE any
 * expected-dependent comparison, so a discrepancy never rolls back the
 * submission; explanations are appended as new immutable revisions.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  CASH_COMMAND_ABILITY,
  assertAbility,
} from '../application/cash-authorization';
import {
  CASH_APPLICATION_CODES,
  cashAppError,
} from '../application/cash-application.errors';
import type {
  CashActor,
  CashCommand,
  CashDocument,
  CashQuery,
  ICashApplication,
} from '../cash-application.port';
import type {
  CashLedgerPayment,
  CashPaymentMethod,
  ICashLedger,
} from '../cash-ledger.port';
import { close } from './cash-adapter-closing';
import {
  annotateDeclaration,
  declare,
  startCount,
  verify,
} from './cash-adapter-counts';
import {
  createHandover,
  receiveHandover,
  releaseDrawer,
} from './cash-adapter-custody';
import { recheckReplayAbility } from './cash-adapter-instances';
import {
  assertOpenSession as ledgerAssertOpenSession,
  recordPayments as ledgerRecordPayments,
  recordRefund as ledgerRecordRefund,
} from './cash-adapter-ledger';
import { manualMovement } from './cash-adapter-movements';
import { openSession } from './cash-adapter-opening';
import {
  queryClosing,
  queryClosings,
  queryRegisters,
  querySession,
  querySessions,
} from './cash-adapter-queries';
import { createRegister, updateRegister } from './cash-adapter-registers';
import {
  assertActiveMember,
  requireAmbientTransaction,
} from './cash-adapter-storage';
import type { TenantClient } from './cash-adapter-client';
import {
  canonicalize,
  documentValue,
  isUniqueViolation,
  prismaJson,
} from './cash-adapter-values';

@Injectable()
export class PrismaCashRegisterApplication
  implements ICashApplication, ICashLedger
{
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  // ── ICashApplication ────────────────────────────────────────────────

  async execute(
    actor: CashActor,
    command: CashCommand,
    idempotencyKey: string,
  ): Promise<CashDocument> {
    const key = this.requireIdempotencyKey(idempotencyKey);
    const requirement = CASH_COMMAND_ABILITY[command.kind];
    if (!requirement) {
      throw cashAppError(
        CASH_APPLICATION_CODES.UNSUPPORTED_COMMAND,
        `Unsupported cash command ${String((command as { kind?: unknown }).kind)}`,
      );
    }
    const tenantId = this.tenantPrisma.getTenantId();
    // Coarse capability fails fast, before any transaction or lock.
    assertAbility(actor, requirement);
    const requestHash = this.hashRequest(actor.userId, command);

    return this.tenantPrisma.runInTransaction(async () => {
      const tx = this.tenantPrisma.getClient();
      await this.acquireIdempotencyLock(tx, tenantId, key);
      const existing = await tx.cashCommand.findFirst({
        where: { tenantId, key },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw cashAppError(
            CASH_APPLICATION_CODES.IDEMPOTENCY_CONFLICT,
            'Idempotency key was already used with a different request',
            { key },
          );
        }
        // Exact replay: skip lifecycle guards but still enforce that the
        // actor remains an active member with the capability, rechecked
        // against the CURRENT authoritative row instance (revocation wins).
        await assertActiveMember(tx, tenantId, actor.userId);
        await recheckReplayAbility(
          tx,
          tenantId,
          actor,
          command,
          existing.responseJson,
        );
        return documentValue(existing.responseJson);
      }

      const result = await this.runCommand(tx, tenantId, actor, command);
      try {
        await tx.cashCommand.create({
          data: {
            tenantId,
            key,
            requestHash,
            responseJson: prismaJson(result),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw cashAppError(
            CASH_APPLICATION_CODES.IDEMPOTENCY_CONFLICT,
            'Idempotency key raced with a concurrent request',
            { key },
          );
        }
        throw error;
      }
      return result;
    });
  }

  async query(actor: CashActor, query: CashQuery): Promise<CashDocument> {
    const tenantId = this.tenantPrisma.getTenantId();
    const tx = this.tenantPrisma.getClient();
    // S3 — every query kind requires an active user AND tenant membership,
    // not merely a valid permission subject.
    await assertActiveMember(tx, tenantId, actor.userId);
    switch (query.kind) {
      case 'REGISTERS':
        return queryRegisters(tx, tenantId, actor);
      case 'SESSION':
        return querySession(tx, tenantId, actor, query.id);
      case 'SESSIONS':
        return querySessions(tx, tenantId, actor, query);
      case 'CLOSINGS':
        return queryClosings(tx, tenantId, actor, query.page);
      case 'CLOSING':
        return queryClosing(tx, tenantId, actor, query.id);
      default: {
        throw cashAppError(
          CASH_APPLICATION_CODES.UNSUPPORTED_COMMAND,
          'Unsupported cash query',
        );
      }
    }
  }

  // ── ICashLedger ─────────────────────────────────────────────────────

  async assertOpenSession(sessionId: string, actorId: string): Promise<void> {
    requireAmbientTransaction(
      this.tenantPrisma.isInTransaction(),
      'assertOpenSession',
    );
    const tenantId = this.tenantPrisma.getTenantId();
    const tx = this.tenantPrisma.getClient();
    await ledgerAssertOpenSession(tx, tenantId, sessionId, actorId);
  }

  async recordPayments(input: {
    sessionId: string;
    actorId: string;
    saleId: string;
    payments: readonly CashLedgerPayment[];
    changeDueCents: number;
    occurredAt: Date;
  }): Promise<void> {
    requireAmbientTransaction(
      this.tenantPrisma.isInTransaction(),
      'recordPayments',
    );
    const tenantId = this.tenantPrisma.getTenantId();
    const tx = this.tenantPrisma.getClient();
    await ledgerRecordPayments(tx, tenantId, input);
  }

  async recordRefund(input: {
    sessionId: string;
    actorId: string;
    settlementId: string;
    amountCents: number;
    method: CashPaymentMethod;
    occurredAt: Date;
  }): Promise<void> {
    requireAmbientTransaction(
      this.tenantPrisma.isInTransaction(),
      'recordRefund',
    );
    const tenantId = this.tenantPrisma.getTenantId();
    const tx = this.tenantPrisma.getClient();
    await ledgerRecordRefund(tx, tenantId, input);
  }

  // ── Idempotency helpers ─────────────────────────────────────────────

  private requireIdempotencyKey(raw: string): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw cashAppError(
        CASH_APPLICATION_CODES.IDEMPOTENCY_KEY_REQUIRED,
        'An idempotency key is required',
      );
    }
    const key = raw.trim();
    if (key.length > 200) {
      throw cashAppError(
        CASH_APPLICATION_CODES.IDEMPOTENCY_KEY_TOO_LONG,
        'Idempotency key must be at most 200 characters',
        { length: key.length },
      );
    }
    return key;
  }

  private hashRequest(actorUserId: string, command: CashCommand): string {
    return createHash('sha256')
      .update(JSON.stringify(canonicalize({ actorUserId, command })))
      .digest('hex');
  }

  private async acquireIdempotencyLock(
    tx: TenantClient,
    tenantId: string,
    key: string,
  ): Promise<void> {
    // Prisma cannot decode PostgreSQL's void result; the cast preserves the
    // transaction-scoped lock while returning a supported scalar type.
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${key}))::text`,
    );
  }

  // ── Command dispatch ────────────────────────────────────────────────

  private async runCommand(
    tx: TenantClient,
    tenantId: string,
    actor: CashActor,
    command: CashCommand,
  ): Promise<CashDocument> {
    await assertActiveMember(tx, tenantId, actor.userId);
    switch (command.kind) {
      case 'CREATE_REGISTER':
        return createRegister(tx, tenantId, actor, command.name);
      case 'UPDATE_REGISTER':
        return updateRegister(tx, tenantId, actor, command);
      case 'OPEN_SESSION':
        return openSession(tx, tenantId, actor, command);
      case 'CASH_IN':
      case 'CASH_OUT':
        return manualMovement(tx, tenantId, actor, command);
      case 'START_COUNT':
        return startCount(tx, tenantId, actor, command.sessionId);
      case 'DECLARE':
        return declare(tx, tenantId, actor, command);
      case 'ANNOTATE_DECLARATION':
        return annotateDeclaration(tx, tenantId, actor, command);
      case 'VERIFY':
        return verify(tx, tenantId, actor, command);
      case 'CREATE_HANDOVER':
        return createHandover(tx, tenantId, actor, command);
      case 'RECEIVE_HANDOVER':
        return receiveHandover(tx, tenantId, actor, command);
      case 'RELEASE_DRAWER':
        return releaseDrawer(tx, tenantId, actor, command.sessionId);
      case 'CLOSE':
        return close(tx, tenantId, actor, command);
      default: {
        throw cashAppError(
          CASH_APPLICATION_CODES.UNSUPPORTED_COMMAND,
          'Unsupported cash command',
        );
      }
    }
  }
}
