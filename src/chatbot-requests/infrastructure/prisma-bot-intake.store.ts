/**
 * Prisma adapter of `BotIntakeStore` (unit 5). The tenant always comes from
 * CLS; every statement runs on the ambient transaction opened by
 * `transaction()` (or, for the two reads the wrapped path makes outside one,
 * on the tenant-scoped client).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CUSTOMER_REPLY_WINDOW_MS } from '../../delivery-zones/domain/delivery-zone.policy';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  BotIntakeStore,
  DirectDraft,
  IntakeOutcome,
} from '../application/bot-request-intake.service';
import type { ChatbotRequestRow } from '../application/chatbot-request-commands.service';
import type { WrappedSubtype } from '../domain/bot-request-envelope';
import type {
  ChatbotRequestEventDraft,
  ChatbotRequestPatch,
} from '../domain/chatbot-request.commands';
import {
  assertIntakeLimits,
  findOpenDedup,
  insertRequestOnDedup,
  IntakeMergeSignal,
  lockBotKey,
  lockCustomerIntake,
  recordMerge,
  type OpenRequestRef,
} from './chatbot-request-intake-writes';
import { ChatbotRequestCommandError } from '../application/chatbot-request-commands.service';
import {
  isBookableStart,
  isWithinWindow,
  reminderAt,
} from '../domain/scheduling';
import { businessHoursView } from '../domain/scheduling-view';
import { slotUnavailable } from './scheduling-reads';
import {
  loadSchedulingConfig,
  reserveSeat,
  type SchedulingConfig,
} from './scheduling-store';
import { linkByPhone, WRAP_SOURCE } from './chatbot-request-wrapper';
import {
  allocateFolio,
  applyRequestPatch,
  assertTenantLinks,
  findZoneOf,
  lockRequestRow,
  refreshCustomerGroup,
} from './chatbot-request-writes';
import { lockZipCode } from '../../delivery-zones/infrastructure/delivery-zone-persistence';
import { enqueueNotice } from '../../notifications/infrastructure/chatbot-request-notice.writer';

/** `source` of the requests the bot creates itself (wrapper rows use `WRAP:`). */
export const BOT_REQUEST_SOURCE = 'houndfe-chatbot';

const WRAPPER_SOURCE: Record<WrappedSubtype, string> = {
  RESTOCK: WRAP_SOURCE.humanDecision,
  EXPIRATION: WRAP_SOURCE.humanDecision,
  DELIVERY_ZONE: WRAP_SOURCE.deliveryZoneRequest,
};

/** The phone a wrapped request's `customerKey` comes from at insert time. */
function insertPhone(
  envelope: DirectDraft['envelope'],
): { phoneCountryCode: string; phone: string } | null {
  if (envelope.subtype === 'DELIVERY_ZONE') {
    const { phoneCountryCode, phone } = envelope.detail;
    return typeof phoneCountryCode === 'string' && typeof phone === 'string'
      ? { phoneCountryCode, phone }
      : null;
  }
  return envelope.customer;
}

@Injectable()
export class PrismaBotIntakeStore implements BotIntakeStore {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private get tx() {
    return this.tenantPrisma.getClient();
  }

  private get tenantId() {
    return this.tenantPrisma.getTenantId();
  }

  transaction<T>(work: () => Promise<T>): Promise<T> {
    return this.tenantPrisma.runInTransaction(work);
  }

  lockKey(kind: 'CREATE' | 'CANCEL', key: string): Promise<void> {
    return lockBotKey(this.tx, this.tenantId, kind, key);
  }

  findReceipt(kind: 'CREATE' | 'CANCEL', idempotencyKey: string) {
    return this.tx.chatbotBotReceipt.findFirst({
      where: { tenantId: this.tenantId, kind, idempotencyKey },
      select: { commandHash: true, responseSnapshot: true },
    });
  }

  async saveReceipt(
    kind: 'CREATE' | 'CANCEL',
    idempotencyKey: string,
    commandHash: string,
    requestId: string | null,
    snapshot: unknown,
  ): Promise<void> {
    await this.tx.chatbotBotReceipt.create({
      data: {
        tenantId: this.tenantId,
        kind,
        idempotencyKey,
        commandHash,
        requestId,
        // SAFETY: the snapshots hold only strings, numbers and nulls.
        responseSnapshot: snapshot as Prisma.InputJsonObject,
      },
    });
  }

  findCreated(sourceRequestId: string) {
    return this.tx.chatbotRequest.findFirst({
      where: {
        tenantId: this.tenantId,
        source: BOT_REQUEST_SOURCE,
        sourceRequestId,
      },
      select: { id: true, folio: true, canonicalRequestHash: true },
    });
  }

  findWrapper(subtype: WrappedSubtype, wrappedId: string) {
    return this.tx.chatbotRequest.findFirst({
      where: {
        tenantId: this.tenantId,
        source: WRAPPER_SOURCE[subtype],
        sourceRequestId: wrappedId,
      },
      select: { id: true, folio: true, canonicalRequestHash: true },
    });
  }

  /**
   * Lock order (rule 2): customer lock, the dedup row, limits, then the folio
   * after every existing-row lock, the insert, and the group last.
   */
  async createDirect(draft: DirectDraft): Promise<IntakeOutcome> {
    const { tx, tenantId } = this;
    const { envelope, credentialId, hash, limits } = draft;
    const customer = envelope.customer;
    if (!customer || !envelope.summary)
      throw new InvalidArgumentError('Invalid');
    const link = await linkByPhone(
      tx,
      tenantId,
      customer.phoneCountryCode,
      customer.phone,
    );
    const customerKey = link.customerKey;
    if (!customerKey) throw new InvalidArgumentError('Invalid');

    await lockCustomerIntake(tx, tenantId, customerKey);
    // Unit 14: a scheduled create never merges (it holds a seat of its own).
    const scheduledFor = envelope.scheduledFor;
    if (envelope.dedupKey && !scheduledFor) {
      const open = await findOpenDedup(
        tx,
        tenantId,
        customerKey,
        envelope.dedupKey,
      );
      if (open) return this.merge(open, draft);
    }
    await assertIntakeLimits(tx, tenantId, customerKey, limits);
    await assertTenantLinks(tx, tenantId, { customerId: link.customerId });

    // Unit 14 (Q16): every create answers the branch's hours; a booking also
    // proves the time and takes the seat HERE, in the insert's transaction
    // (lock order: customer lock, settings share, counter, folio, insert).
    const now = new Date();
    const config = await loadSchedulingConfig(tx, tenantId, 'SHARE');
    const businessHours = businessHoursView(config.calendar, now);
    const lastMessage = envelope.lastCustomerMessageAt;
    const windowClosesAt = lastMessage
      ? new Date(lastMessage.getTime() + CUSTOMER_REPLY_WINDOW_MS)
      : null;
    let schedule: IntakeOutcome['schedule'];
    if (scheduledFor) {
      schedule = await this.bookSeat(
        { customerKey, subtype: envelope.subtype, scheduledFor },
        config,
        now,
        windowClosesAt ?? now,
      );
    }

    const folio = await allocateFolio(tx, tenantId);
    const id = await insertRequestOnDedup(tx, {
      tenantId,
      folio,
      kind:
        envelope.subtype === 'UNKNOWN_QUESTION'
          ? 'CLARIFICATION'
          : 'CONVERSATION',
      subtype: envelope.subtype as 'UNKNOWN_QUESTION',
      customerKey,
      customerId: link.customerId,
      ambiguousCustomer: link.ambiguousCustomer,
      phoneCountryCode: link.phoneCountryCode,
      phone: link.phone,
      conversationRef: envelope.conversationRef,
      lastCustomerMessageAt: lastMessage,
      whatsappWindowClosesAt: windowClosesAt,
      summary: envelope.summary,
      needs: envelope.needs,
      context: envelope.context ?? undefined,
      dedupKey: scheduledFor ? null : envelope.dedupKey,
      ...(schedule
        ? {
            scheduledFor: schedule.scheduledFor,
            requiresTemplateAtStart: schedule.requiresTemplateAtStart,
            scheduleVersion: schedule.scheduleVersion,
            scheduleStage: 0,
            scheduleDueAt: reminderAt(schedule.scheduledFor),
          }
        : {}),
      source: BOT_REQUEST_SOURCE,
      sourceRequestId: envelope.sourceRequestId,
      canonicalRequestHash: hash,
      submittedCredentialId: credentialId,
    });
    // Lost the dedup race to a creator that skipped the lock: merge next try.
    if (!id) throw new IntakeMergeSignal();
    await tx.chatbotRequestEvent.create({
      data: {
        tenantId,
        requestId: id,
        type: 'CREATED',
        actorKind: 'SERVICE',
        actorId: credentialId,
        toStatus: 'NEW',
        version: 1,
        data: {
          subtype: envelope.subtype,
          sourceRequestId: envelope.sourceRequestId,
          triggerWaMessageId: envelope.triggerWaMessageId,
          ...(schedule
            ? {
                scheduledFor: schedule.scheduledFor.toISOString(),
                requiresTemplate: schedule.requiresTemplateAtStart,
                scheduleVersion: schedule.scheduleVersion,
              }
            : {}),
        },
      },
    });
    // Unit 6: one outbox row in this transaction; a rollback leaves no notice.
    // A scheduled request is announced at `scheduledFor`, not at booking
    // (§4.9.4; the schedule sweep is a later step of unit 14).
    if (!schedule) {
      await enqueueNotice(tx, tenantId, {
        type: 'REQUEST_CREATED',
        requestId: id,
        folio,
        subtype: envelope.subtype,
        dedupKey: `created:${id}`,
      });
    }
    await refreshCustomerGroup(tx, tenantId, customerKey);
    return {
      outcome: 'CREATED',
      id,
      folio,
      status: 'NEW',
      businessHours,
      ...(schedule ? { schedule: { ...schedule, windowClosesAt } } : {}),
    };
  }

  /**
   * The booking rules, under the customer lock: scheduling enabled, one open
   * scheduled request per customer and subtype (S19 Q4, S20 9: the identity is
   * the customer key, `customerId` when linked else the canonical phone), the
   * time is exactly a bookable block, and a free seat (one atomic upsert, so
   * two bookings for the last seat cannot both win). Any refusal throws, which
   * rolls the transaction back: nothing is stored (S20 1).
   */
  private async bookSeat(
    who: { customerKey: string; subtype: string; scheduledFor: Date },
    config: SchedulingConfig,
    now: Date,
    windowClosesAt: Date,
  ): Promise<NonNullable<IntakeOutcome['schedule']>> {
    const { tx, tenantId } = this;
    const { scheduling } = config.settings;
    if (!scheduling.enabled) {
      throw new ChatbotRequestCommandError('SCHEDULING_DISABLED', 422);
    }
    const [open] = await tx.$queryRaw<
      Array<{ id: string; scheduledFor: Date }>
    >(Prisma.sql`
      SELECT "id", "scheduledFor" FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "customerKey" = ${who.customerKey}
        AND "subtype" = ${who.subtype}::"ChatbotRequestSubtype"
        AND "scheduledFor" IS NOT NULL AND "status" IN ('NEW', 'IN_PROGRESS')
      LIMIT 1`);
    if (open) {
      throw new ChatbotRequestCommandError(
        'ALREADY_SCHEDULED',
        409,
        undefined,
        {
          requestId: open.id,
          scheduledFor: open.scheduledFor.toISOString(),
        },
      );
    }
    const bookable = isBookableStart({
      calendar: config.calendar,
      slotMinutes: scheduling.slotMinutes,
      now,
      startsAt: who.scheduledFor,
    });
    if (
      !bookable ||
      !(await reserveSeat(
        tx,
        tenantId,
        who.scheduledFor,
        scheduling.maxScheduledPerSlot,
      ))
    ) {
      throw await slotUnavailable(tx, tenantId, config, now, windowClosesAt);
    }
    return {
      scheduledFor: who.scheduledFor,
      scheduleVersion: 1,
      requiresTemplateAtStart: !isWithinWindow(
        who.scheduledFor,
        windowClosesAt,
      ),
      windowClosesAt: null,
    };
  }

  /**
   * Recovery after the hook signalled a merge. The key is derived exactly as
   * the creator derived the one the partial unique index holds: `linkByPhone`
   * (the same call `createDirect` and the hook make) on the phone the request
   * is inserted under, which for a zone requester is the phone of its own
   * detail (the envelope customer is only checked against it).
   */
  async mergeOpen(draft: DirectDraft): Promise<IntakeOutcome | null> {
    const { tx, tenantId } = this;
    const { envelope } = draft;
    const phone = insertPhone(envelope);
    if (!phone || !envelope.dedupKey) return null;
    const { customerKey } = await linkByPhone(
      tx,
      tenantId,
      phone.phoneCountryCode,
      phone.phone,
    );
    if (!customerKey) return null;
    await lockCustomerIntake(tx, tenantId, customerKey);
    const open = await findOpenDedup(
      tx,
      tenantId,
      customerKey,
      envelope.dedupKey,
    );
    return open ? this.merge(open, draft) : null;
  }

  private async merge(
    open: OpenRequestRef,
    draft: DirectDraft,
  ): Promise<IntakeOutcome> {
    const { envelope, credentialId } = draft;
    await recordMerge(this.tx, this.tenantId, open, {
      credentialId,
      sourceRequestId: envelope.sourceRequestId,
      triggerWaMessageId: envelope.triggerWaMessageId,
      lastCustomerMessageAt: envelope.lastCustomerMessageAt,
    });
    return {
      outcome: 'MERGED',
      id: open.id,
      folio: open.folio,
      status: open.status,
    };
  }

  // ------------------------------------------------------------------ cancel

  async lockZoneOf(requestId: string): Promise<void> {
    const zone = await findZoneOf(this.tx, this.tenantId, requestId);
    if (zone) await lockZipCode(this.tx, this.tenantId, zone.zipCode);
  }

  lockRequest(requestId: string): Promise<ChatbotRequestRow | null> {
    return lockRequestRow(this.tx, this.tenantId, requestId);
  }

  async applyCancel(
    row: ChatbotRequestRow,
    patch: ChatbotRequestPatch,
    event: ChatbotRequestEventDraft,
  ): Promise<void> {
    await applyRequestPatch(this.tx, this.tenantId, row, patch, event);
    // Unit 6: the customer cancelled; tell whoever was attending it (nobody
    // is told about a request nobody had taken).
    await enqueueNotice(this.tx, this.tenantId, {
      type: 'REQUEST_CANCELLED',
      requestId: row.id,
      folio: row.folio,
      subtype: row.subtype,
      dedupKey: `cancelled:${row.id}`,
      ...(row.assigneeUserId ? { recipientUserId: row.assigneeUserId } : {}),
    });
    await refreshCustomerGroup(this.tx, this.tenantId, row.customerKey);
  }

  async readResolution(requestId: string): Promise<unknown> {
    const row = await this.tx.chatbotRequest.findFirst({
      where: { tenantId: this.tenantId, id: requestId },
      select: { resolution: true },
    });
    return row?.resolution ?? null;
  }
}
