/**
 * Prisma adapter of `SchedulingStore` (human-intervention unit 14; contract
 * "Scheduled conversations"): the slots reads and the reschedule write. The
 * tenant always comes from CLS. `reschedule` runs on the AMBIENT transaction
 * the caller opened (the bot's receipt, or the staff command's receipt), in the
 * lock order of docs/chatbot-requests-model.md: request row, settings share,
 * counter rows (both, in `startsAt` order), feed lock, customer group.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  ChatbotRequestCommandError,
  type ChatbotRequestRow,
} from '../application/chatbot-request-commands.service';
import type {
  RescheduleInput,
  RescheduleResult,
  SchedulingStore,
  SlotsAnswer,
} from '../application/scheduling.service';
import type {
  ChatbotRequestPatch,
  ChatbotRequestEventDraft,
} from '../domain/chatbot-request.commands';
import {
  isBookableStart,
  isWithinWindow,
  reminderAt,
} from '../domain/scheduling';
import {
  businessHoursDetail,
  newestInstant,
  rescheduleRefusal,
  slotViews,
  windowClosesAtOf,
} from '../domain/scheduling-view';
import { enqueueRescheduled } from './chatbot-feed-writes';
import {
  applyRequestPatch,
  lockRequestRow,
  refreshCustomerGroup,
} from './chatbot-request-writes';
import { slaColumnsForTransition } from './chatbot-sla-policy';
import { freshSlots, slotUnavailable } from './scheduling-reads';
import { loadSchedulingConfig, moveSeat } from './scheduling-store';

@Injectable()
export class PrismaSchedulingStore implements SchedulingStore {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private get db() {
    return this.tenantPrisma.getClient();
  }

  private get tenantId() {
    return this.tenantPrisma.getTenantId();
  }

  /** The newest customer message the backend knows for a chat / request. */
  private async lastMessageOf(
    conversationRef: string | null,
    requestLast: Date | null,
  ): Promise<Date | null> {
    if (!conversationRef) return requestLast;
    const [chat] = await this.db.$queryRaw<
      Array<{ lastCustomerMessageAt: Date | null }>
    >(Prisma.sql`
      SELECT "lastCustomerMessageAt" FROM "chatbot_conversations"
      WHERE "tenantId" = ${this.tenantId}
        AND "conversationRef" = ${conversationRef}`);
    return newestInstant(requestLast, chat?.lastCustomerMessageAt);
  }

  private async answer(
    now: Date,
    last: Date | null,
    mode: 'OFFER' | 'PICKER',
  ): Promise<SlotsAnswer> {
    const config = await loadSchedulingConfig(this.db, this.tenantId);
    if (!config.settings.scheduling.enabled) {
      throw new ChatbotRequestCommandError('SCHEDULING_DISABLED', 422);
    }
    // no known customer message time: the window is closed now (as booking)
    const closes = last ? windowClosesAtOf(last) : now;
    const slots = await freshSlots(
      this.db,
      this.tenantId,
      config,
      now,
      closes,
      mode,
    );
    return {
      timeZone: config.calendar.timeZone,
      whatsappWindowClosesAt: closes.toISOString(),
      businessHours: businessHoursDetail(config.calendar, config.settings, now),
      slots: slotViews(slots),
    };
  }

  async slotsForChat(
    conversationRef: string,
    hint: Date | null,
  ): Promise<SlotsAnswer> {
    const now = new Date();
    const last = newestInstant(
      hint,
      await this.lastMessageOf(conversationRef, null),
    );
    return this.answer(now, last, 'OFFER');
  }

  async slotsForRequest(requestId: string): Promise<SlotsAnswer> {
    const [row] = await this.db.$queryRaw<
      Array<{ conversationRef: string | null; last: Date | null }>
    >(Prisma.sql`
      SELECT "conversationRef", "lastCustomerMessageAt" AS "last"
      FROM "chatbot_requests"
      WHERE "tenantId" = ${this.tenantId} AND "id" = ${requestId}`);
    if (!row) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    const now = new Date();
    return this.answer(
      now,
      await this.lastMessageOf(row.conversationRef, row.last),
      'PICKER',
    );
  }

  async reschedule(input: RescheduleInput): Promise<RescheduleResult> {
    const { tenantId } = this;
    const tx = this.db;
    const now = new Date();
    const row = await lockRequestRow(tx, tenantId, input.requestId);
    if (!row) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    const current = {
      version: row.version,
      status: row.status,
      claimedBy:
        row.assigneeUserId && row.assigneeDisplayName
          ? { id: row.assigneeUserId, displayName: row.assigneeDisplayName }
          : null,
    };
    const config = await loadSchedulingConfig(tx, tenantId, 'SHARE');
    const { scheduling } = config.settings;
    if (!scheduling.enabled) {
      throw new ChatbotRequestCommandError('SCHEDULING_DISABLED', 422);
    }
    if (row.status === 'RESOLVED' || row.status === 'CANCELLED') {
      throw new ChatbotRequestCommandError('REQUEST_CLOSED', 409, current);
    }
    if (
      input.expectedVersion !== null &&
      row.version !== input.expectedVersion
    ) {
      throw new ChatbotRequestCommandError('VERSION_CONFLICT', 409, current);
    }
    const refusal = rescheduleRefusal(row);
    if (refusal) throw new ChatbotRequestCommandError(refusal, 409, current);
    const from = row.scheduledFor as Date;

    const [stored] = await tx.$queryRaw<
      Array<{ last: Date | null; requiresTemplate: boolean }>
    >(Prisma.sql`
      SELECT "lastCustomerMessageAt" AS "last",
             "requiresTemplateAtStart" AS "requiresTemplate"
      FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "id" = ${row.id}`);
    const last = newestInstant(
      input.lastCustomerMessageAt,
      await this.lastMessageOf(row.conversationRef, stored.last),
    );
    // no known customer message time: the window is closed now (as booking)
    const closes = last ? windowClosesAtOf(last) : now;
    const noticeExpected = closes.getTime() > now.getTime();
    const base = {
      scheduleVersion: row.scheduleVersion ?? 0,
      windowClosesAt: closes,
      customerNoticeExpected: noticeExpected,
      previousScheduledFor: from,
    };

    if (from.getTime() === input.to.getTime()) {
      return {
        ...base,
        outcome: 'UNCHANGED',
        request: row,
        scheduledFor: from,
        requiresTemplateAtStart: stored.requiresTemplate,
      };
    }

    const bookable = isBookableStart({
      calendar: config.calendar,
      slotMinutes: scheduling.slotMinutes,
      now,
      startsAt: input.to,
    });
    // A refused move throws: the caller's transaction rolls back, so the old
    // seat `moveSeat` may already have released is given back with it.
    if (
      !bookable ||
      !(await moveSeat(
        tx,
        tenantId,
        from,
        input.to,
        scheduling.maxScheduledPerSlot,
      ))
    ) {
      throw await slotUnavailable(tx, tenantId, config, now, closes, current);
    }

    const requiresTemplateAtStart = !isWithinWindow(input.to, closes);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "chatbot_requests" SET "scheduledFor" = ${input.to}
      WHERE "tenantId" = ${tenantId} AND "id" = ${row.id}`);
    // The claim and resolve clocks restart at the new time.
    const sla = await slaColumnsForTransition(tx, tenantId, row.id, 'NEW', now);
    const scheduleVersion = (row.scheduleVersion ?? 0) + 1;
    const patch: ChatbotRequestPatch = {
      ...(sla ?? {}),
      version: row.version + 1,
      scheduledFor: input.to,
      scheduleVersion,
      scheduleStage: 0,
      scheduleDueAt: reminderAt(input.to),
      needsReschedule: false,
      needsRescheduleReason: null,
      requiresTemplateAtStart,
    };
    const staff = input.actor.kind === 'USER' ? input.actor : null;
    const event: ChatbotRequestEventDraft = {
      type: 'RESCHEDULED',
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      actorDisplayName: staff ? staff.displayName : null,
      fromStatus: row.status,
      toStatus: row.status,
      version: patch.version,
      data: {
        from: from.toISOString(),
        to: input.to.toISOString(),
        requiresTemplate: requiresTemplateAtStart,
        scheduleVersion,
        // S20 10: audit only; idempotency is the key of the route.
        ...(staff
          ? { byUser: { id: staff.id, displayName: staff.displayName } }
          : { triggerWaMessageId: input.triggerWaMessageId }),
      },
    };
    await applyRequestPatch(tx, tenantId, row, patch, event, now);
    if (staff) {
      await enqueueRescheduled(tx, tenantId, row.conversationRef, {
        requestId: row.id,
        scheduledFor: input.to,
        previousScheduledFor: from,
        scheduleVersion,
        timeZone: config.calendar.timeZone,
        whatsappWindowClosesAt: closes,
        requiresTemplateAtStart,
      });
    }
    await refreshCustomerGroup(tx, tenantId, row.customerKey);
    return {
      ...base,
      outcome: 'RESCHEDULED',
      request: { ...row, ...patch } as ChatbotRequestRow,
      scheduledFor: input.to,
      scheduleVersion,
      requiresTemplateAtStart,
    };
  }
}
