/**
 * shipping-zones / T1 (S2, S3) — ADAPTER: PrismaDeliveryZoneBotRepository.
 *
 * Intake runs in ONE tenant transaction under the per-postal-code advisory
 * lock shared with the store resolve/upsert:
 *   1. replay or 409 by `(tenantId, source, sourceRequestId)`;
 *   2. active zone -> requester created RESOLVED (`EXISTING_ZONE`);
 *   3. otherwise join the PENDING validation of the postal code, opening it
 *      (plus the DELIVERY_ZONE_VALIDATION_REQUESTED outbox row when the tenant
 *      enabled the action) when there is none.
 * A `P2002` on the requester identity (same key raced for another postal code)
 * is recovered outside the aborted transaction by re-reading the winner.
 *
 * The ACK mirrors `PrismaBotApplicationOutcomeRepository` on the requester
 * row: RESOLVED v2 only, one terminal per requester, exact replay by attempt
 * id + evidence hash, and a fixed 24 h application window.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  BotApplicationOutcomeError,
  type BotApplicationOutcomeErrorCode,
  type BotApplicationOutcomeResult,
  type RecordBotApplicationOutcomeCommand,
} from '../../human-decisions/domain/bot-application-outcome.repository';
import {
  DELIVERY_UNKNOWN,
  hashBotApplicationOutcomeEvidence,
  parseBotApplicationOutcomeRequest,
  PROVIDER_ACCEPTED,
  PROVIDER_ACCEPTED_LATE,
  STALE,
  type BotApplicationOutcomeRequest,
} from '../../human-decisions/domain/bot-application-outcome.request';
import { CUSTOMER_REPLY_WINDOW_MS } from '../domain/delivery-zone.policy';
import {
  DELIVERY_ZONE_SOURCE,
  hashDeliveryZoneIntake,
} from '../domain/delivery-zone-intake.request';
import {
  DELIVERY_ZONE_VALIDATION_REQUESTED_EVENT,
  DeliveryZoneIntakeError,
  type DeliveryZoneIntakeResult,
  type DeliveryZoneRequestRecord,
  type DeliveryZoneValidationRequestedPayload,
  type IDeliveryZoneBotRepository,
  type SubmitDeliveryZoneIntakeCommand,
} from '../domain/delivery-zone-bot.repository';
import {
  lockZipCode,
  type TenantScopedClient,
} from './delivery-zone-persistence';

const REQUEST_RECORD_SELECT = {
  id: true,
  sourceRequestId: true,
  canonicalRequestHash: true,
  validationId: true,
  branchName: true,
  zipCode: true,
  state: true,
  municipality: true,
  neighborhood: true,
  status: true,
  version: true,
  createdAt: true,
  resolutionSource: true,
  zoneType: true,
  surchargeCents: true,
  etaDays: true,
  resolvedAt: true,
} satisfies Prisma.DeliveryZoneRequestSelect;

type RequestRow = Prisma.DeliveryZoneRequestGetPayload<{
  select: typeof REQUEST_RECORD_SELECT;
}>;

const OUTCOME_STATE_SELECT = {
  id: true,
  status: true,
  version: true,
  resolvedAt: true,
  applicationOutcome: true,
  applicationAttemptId: true,
  applicationEvidenceHash: true,
  ackReceivedAt: true,
} satisfies Prisma.DeliveryZoneRequestSelect;

type OutcomeStateRow = Prisma.DeliveryZoneRequestGetPayload<{
  select: typeof OUTCOME_STATE_SELECT;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ACK_MESSAGES: Record<BotApplicationOutcomeErrorCode, string> = {
  NOT_FOUND: 'Human decision not found',
  VERSION_CONFLICT: 'Human decision version conflict',
  IDEMPOTENCY_CONFLICT: 'Application outcome conflicts with the committed ACK',
  OUTCOME_ALREADY_RECORDED:
    'A terminal application outcome is already recorded',
};

function failAck(code: BotApplicationOutcomeErrorCode): never {
  throw new BotApplicationOutcomeError(code, ACK_MESSAGES[code]);
}

function failWindow(): never {
  throw new InvalidArgumentError(
    'Bot application outcome is outside the resolution window',
    'INVALID_OUTCOME_WINDOW',
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function toRecord(row: RequestRow): DeliveryZoneRequestRecord {
  return {
    id: row.id,
    sourceRequestId: row.sourceRequestId,
    validationId: row.validationId,
    branchName: row.branchName,
    zipCode: row.zipCode,
    state: row.state,
    municipality: row.municipality,
    neighborhood: row.neighborhood,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    resolutionSource: row.resolutionSource,
    zoneType: row.zoneType,
    surchargeCents: row.surchargeCents,
    etaDays: row.etaDays,
    resolvedAt: row.resolvedAt,
  };
}

@Injectable()
export class PrismaDeliveryZoneBotRepository implements IDeliveryZoneBotRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async submit(
    command: SubmitDeliveryZoneIntakeCommand,
  ): Promise<DeliveryZoneIntakeResult> {
    const tenantId = this.tenantPrisma.getTenantId();
    const { request } = command;
    const hash = hashDeliveryZoneIntake(request);

    try {
      return await this.tenantPrisma.runInTransaction(async () => {
        const db = this.tenantPrisma.getClient();
        await lockZipCode(db, tenantId, request.zipCode);

        const existing = await this.findBySourceRequestId(
          db,
          tenantId,
          request.sourceRequestId,
        );
        if (existing !== null) {
          return this.replay(existing, hash);
        }

        const tenant = await db.tenant.findUnique({
          where: { id: tenantId },
          select: { name: true },
        });
        const base = {
          tenantId,
          source: DELIVERY_ZONE_SOURCE,
          sourceRequestId: request.sourceRequestId,
          canonicalRequestHash: hash,
          submittedCredentialId: command.submittedCredentialId,
          branchName: tenant?.name ?? null,
          zipCode: request.zipCode,
          state: request.state,
          municipality: request.municipality,
          neighborhood: request.neighborhood,
          customerPhoneCountryCode: request.phoneCountryCode,
          customerPhone: request.phone,
          conversationRef: request.conversationRef,
          lastCustomerMessageAt: request.lastCustomerMessageAt,
        };

        const zone = await db.deliveryZone.findFirst({
          where: { tenantId, zipCode: request.zipCode, isActive: true },
          select: { type: true, surchargeCents: true, etaDays: true },
        });
        if (zone !== null) {
          const created = await db.deliveryZoneRequest.create({
            data: {
              ...base,
              status: 'RESOLVED',
              version: 2,
              resolutionSource: 'EXISTING_ZONE',
              zoneType: zone.type,
              surchargeCents: zone.surchargeCents,
              etaDays: zone.etaDays,
              resolvedAt: new Date(),
            },
            select: REQUEST_RECORD_SELECT,
          });
          return { status: 'created', record: toRecord(created) };
        }

        const validationId = await this.findOrOpenValidation(
          db,
          tenantId,
          base.branchName,
          command,
        );
        const created = await db.deliveryZoneRequest.create({
          data: { ...base, validationId },
          select: REQUEST_RECORD_SELECT,
        });
        return { status: 'created', record: toRecord(created) };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const winner = await this.findBySourceRequestId(
        this.tenantPrisma.getClient(),
        tenantId,
        request.sourceRequestId,
      );
      if (winner === null) {
        throw error;
      }
      return this.replay(winner, hash);
    }
  }

  async findRequestById(id: string): Promise<DeliveryZoneRequestRecord | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const tenantId = this.tenantPrisma.getTenantId();
    const row = await this.tenantPrisma
      .getClient()
      .deliveryZoneRequest.findFirst({
        where: { id, tenantId, source: DELIVERY_ZONE_SOURCE },
        select: REQUEST_RECORD_SELECT,
      });
    return row === null ? null : toRecord(row);
  }

  async recordOutcome(
    command: RecordBotApplicationOutcomeCommand,
  ): Promise<BotApplicationOutcomeResult> {
    const tenantId = this.tenantPrisma.getTenantId();
    const request = parseBotApplicationOutcomeRequest(command.request);
    const evidenceHash = hashBotApplicationOutcomeEvidence(request);
    const ackReceivedAt = new Date();
    const id = command.decisionId;

    return this.tenantPrisma.runInTransaction(async () => {
      const db = this.tenantPrisma.getClient();
      const read = () =>
        db.deliveryZoneRequest.findFirst({
          where: { id, tenantId, source: DELIVERY_ZONE_SOURCE },
          select: OUTCOME_STATE_SELECT,
        });

      const current = await read();
      if (current === null) {
        return failAck('NOT_FOUND');
      }
      this.assertEligible(current, request);
      if (current.applicationOutcome !== null) {
        return this.classifyTerminal(current, request, evidenceHash);
      }
      if (current.resolvedAt === null) {
        throw new Error('Resolved delivery-zone requester without resolvedAt');
      }
      this.assertWindow(request, current.resolvedAt);

      const updated = await db.deliveryZoneRequest.updateMany({
        where: {
          id,
          tenantId,
          status: 'RESOLVED',
          version: 2,
          applicationOutcome: null,
        },
        data: {
          applicationOutcome: request.outcome,
          applicationAttemptId: request.attemptId,
          applicationEvidenceHash: evidenceHash,
          providerMessageId: providerMessageIdOf(request),
          providerAcceptedObservedAt: providerAcceptedObservedAtOf(request),
          applicationAttemptedAt:
            request.outcome === STALE ? null : new Date(request.attemptedAt),
          ackReceivedAt,
        },
      });
      const committed = await read();
      if (committed === null) {
        throw new Error('Delivery-zone requester vanished during ACK');
      }
      if (updated.count === 1) {
        return { status: 'recorded', acknowledgment: toAck(committed) };
      }
      if (committed.applicationOutcome === null) {
        return failAck('VERSION_CONFLICT');
      }
      return this.classifyTerminal(committed, request, evidenceHash);
    });
  }

  private findBySourceRequestId(
    db: TenantScopedClient,
    tenantId: string,
    sourceRequestId: string,
  ): Promise<RequestRow | null> {
    return db.deliveryZoneRequest.findFirst({
      where: { tenantId, source: DELIVERY_ZONE_SOURCE, sourceRequestId },
      select: REQUEST_RECORD_SELECT,
    });
  }

  private replay(row: RequestRow, hash: string): DeliveryZoneIntakeResult {
    if (row.canonicalRequestHash !== hash) {
      throw new DeliveryZoneIntakeError(
        'IDEMPOTENCY_CONFLICT',
        'A different request was already submitted for this idempotency key',
      );
    }
    return { status: 'replayed', record: toRecord(row) };
  }

  /** The single PENDING validation of the postal code, opened on demand. */
  private async findOrOpenValidation(
    db: TenantScopedClient,
    tenantId: string,
    branchName: string | null,
    command: SubmitDeliveryZoneIntakeCommand,
  ): Promise<string> {
    const { request } = command;
    const open = await db.deliveryZoneValidation.findFirst({
      where: { tenantId, zipCode: request.zipCode, status: 'PENDING' },
      select: { id: true },
    });
    if (open !== null) {
      return open.id;
    }
    const validation = await db.deliveryZoneValidation.create({
      data: {
        tenantId,
        zipCode: request.zipCode,
        state: request.state,
        municipality: request.municipality,
        neighborhood: request.neighborhood,
        branchName,
      },
      select: { id: true },
    });
    if (await this.isNotificationEnabled(db, tenantId)) {
      const payload: DeliveryZoneValidationRequestedPayload = {
        tenantId,
        validationId: validation.id,
        branchName,
        zipCode: request.zipCode,
        state: request.state,
        municipality: request.municipality,
        neighborhood: request.neighborhood,
        lastCustomerMessageAt: request.lastCustomerMessageAt.toISOString(),
        deadlineAt: new Date(
          request.lastCustomerMessageAt.getTime() + CUSTOMER_REPLY_WINDOW_MS,
        ).toISOString(),
      };
      // Same transaction as the validation: both commit or neither does.
      await db.outboxEvent.create({
        data: {
          tenantId,
          aggregateType: 'DeliveryZoneValidation',
          aggregateId: validation.id,
          eventType: DELIVERY_ZONE_VALIDATION_REQUESTED_EVENT,
          payload: { ...payload },
          status: 'PENDING',
          retryCount: 0,
        },
      });
    }
    return validation.id;
  }

  /** Write-time gate: master toggle ON and the action enabled (re-gated at send). */
  private async isNotificationEnabled(
    db: TenantScopedClient,
    tenantId: string,
  ): Promise<boolean> {
    const [settings, action] = await Promise.all([
      db.notificationSettings.findFirst({
        where: { tenantId },
        select: { enabled: true },
      }),
      db.notificationAction.findFirst({
        where: { tenantId, action: 'DELIVERY_ZONE_VALIDATION_REQUESTED' },
        select: { id: true },
      }),
    ]);
    return settings?.enabled === true && action !== null;
  }

  private assertEligible(
    row: OutcomeStateRow,
    request: BotApplicationOutcomeRequest,
  ): void {
    if (
      row.status !== 'RESOLVED' ||
      request.expectedResolutionVersion !== 2 ||
      row.version !== 2
    ) {
      failAck('VERSION_CONFLICT');
    }
  }

  /** Half-open `[resolvedAt, resolvedAt + 24 h)` window, as for EXPIRATION. */
  private assertWindow(
    request: BotApplicationOutcomeRequest,
    resolvedAt: Date,
  ): void {
    if (request.outcome === STALE) {
      return;
    }
    const start = resolvedAt.getTime();
    const end = start + CUSTOMER_REPLY_WINDOW_MS;
    const attempted = new Date(request.attemptedAt).getTime();
    if (attempted < start || attempted >= end) {
      failWindow();
    }
    if (request.outcome === PROVIDER_ACCEPTED) {
      if (new Date(request.providerAcceptedObservedAt).getTime() >= end) {
        failWindow();
      }
    } else if (request.outcome === PROVIDER_ACCEPTED_LATE) {
      if (new Date(request.providerAcceptedObservedAt).getTime() < end) {
        failWindow();
      }
    }
  }

  private classifyTerminal(
    row: OutcomeStateRow,
    request: BotApplicationOutcomeRequest,
    evidenceHash: string,
  ): BotApplicationOutcomeResult {
    if (row.applicationAttemptId !== request.attemptId) {
      return failAck('OUTCOME_ALREADY_RECORDED');
    }
    if (row.applicationEvidenceHash !== evidenceHash) {
      return failAck('IDEMPOTENCY_CONFLICT');
    }
    return { status: 'replayed', acknowledgment: toAck(row) };
  }
}

function providerMessageIdOf(
  request: BotApplicationOutcomeRequest,
): string | null {
  if (
    request.outcome === PROVIDER_ACCEPTED ||
    request.outcome === PROVIDER_ACCEPTED_LATE
  ) {
    return request.providerMessageId;
  }
  if (request.outcome === DELIVERY_UNKNOWN) {
    return request.providerMessageId ?? null;
  }
  return null;
}

function providerAcceptedObservedAtOf(
  request: BotApplicationOutcomeRequest,
): Date | null {
  return request.outcome === PROVIDER_ACCEPTED ||
    request.outcome === PROVIDER_ACCEPTED_LATE
    ? new Date(request.providerAcceptedObservedAt)
    : null;
}

function toAck(
  row: OutcomeStateRow,
): BotApplicationOutcomeResult['acknowledgment'] {
  if (
    row.applicationOutcome === null ||
    row.applicationAttemptId === null ||
    row.ackReceivedAt === null
  ) {
    throw new Error('Delivery-zone requester terminal without ACK columns');
  }
  return {
    id: row.id,
    version: 2,
    attemptId: row.applicationAttemptId,
    outcome: row.applicationOutcome,
    ackReceivedAt: row.ackReceivedAt,
  };
}
