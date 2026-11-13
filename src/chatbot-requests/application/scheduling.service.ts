/**
 * APPLICATION: scheduled conversations, the parts after booking (human-
 * intervention unit 14; contract "Scheduled conversations (unit 14)"):
 *
 *   - `slots`      GET /chatbot-api/scheduling/slots (bot), the staff picker;
 *   - `botReschedule`   POST /chatbot-api/requests/:id/reschedule: idempotent on
 *                  the `X-Idempotency-Key` (a bot receipt of kind RESCHEDULE);
 *                  only a 2xx is stored (S20 1: a 4xx rolls everything back);
 *   - `staffReschedule` POST /chatbot-requests/:id/reschedule: the staff
 *                  receipt, `expectedVersion`, `conversation.rescheduled` for
 *                  the bot and `customerNotice.expected` for the screen (S19 Q9).
 *
 * The seat, the feed item and the audit are written by the store inside the
 * receipt's transaction, so a refusal leaves nothing behind.
 */
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { isToken, isUuid } from '../domain/bot-request-envelope';
import {
  parseInstant,
  parseRecentInstant,
  type BusinessHoursDetail,
  type SlotView,
} from '../domain/scheduling-view';
import {
  BOT_INTAKE_STORE,
  type BotIntakeStore,
} from './bot-request-intake.service';
import {
  CHATBOT_REQUEST_COMMAND_STORE,
  ChatbotRequestCommandError,
  toRequestView,
  withStaffReceipt,
  type ChatbotRequestCommandStore,
  type ChatbotRequestRow,
  type ChatbotRequestView,
} from './chatbot-request-commands.service';

export const SCHEDULING_STORE = Symbol('SCHEDULING_STORE');

export interface SlotsAnswer {
  timeZone: string;
  whatsappWindowClosesAt: string;
  businessHours: BusinessHoursDetail;
  slots: SlotView[];
}

export interface RescheduleInput {
  requestId: string;
  to: Date;
  /** `null` for the bot (it has no version); the CAS of a staff command. */
  expectedVersion: number | null;
  lastCustomerMessageAt: Date | null;
  triggerWaMessageId: string | null;
  actor:
    | { kind: 'SERVICE'; id: string }
    | { kind: 'USER'; id: string; displayName: string };
}

export interface RescheduleResult {
  outcome: 'RESCHEDULED' | 'UNCHANGED';
  request: ChatbotRequestRow;
  scheduledFor: Date;
  previousScheduledFor: Date;
  scheduleVersion: number;
  requiresTemplateAtStart: boolean;
  windowClosesAt: Date;
  /** The 24 h window is open, so the bot can tell the customer (S19 Q9). */
  customerNoticeExpected: boolean;
}

export interface SchedulingStore {
  slotsForChat(
    conversationRef: string,
    hint: Date | null,
  ): Promise<SlotsAnswer>;
  slotsForRequest(requestId: string): Promise<SlotsAnswer>;
  /** On the ambient transaction; throws `ChatbotRequestCommandError`. */
  reschedule(input: RescheduleInput): Promise<RescheduleResult>;
}

export interface BotRescheduleResponse {
  id: string;
  status: string;
  outcome: 'RESCHEDULED' | 'UNCHANGED';
  scheduledFor: string;
  previousScheduledFor: string;
  scheduleVersion: number;
  requiresTemplateAtStart: boolean;
  whatsappWindowClosesAt: string;
}

export interface StaffRescheduleView extends ChatbotRequestView {
  scheduledFor: string;
  previousScheduledFor: string;
  scheduleVersion: number;
  requiresTemplateAtStart: boolean;
  customerNotice: { expected: boolean };
}

const REF = /^[A-Za-z0-9:_.@+-]{1,200}$/;
const invalid = () =>
  new InvalidArgumentError('Invalid scheduling request', 'VALIDATION_ERROR');

const exactKeys = (
  body: unknown,
  allowed: string[],
): Record<string, unknown> => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid();
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw invalid();
  }
  return record;
};

@Injectable()
export class SchedulingService {
  constructor(
    @Inject(SCHEDULING_STORE) private readonly store: SchedulingStore,
    @Inject(BOT_INTAKE_STORE) private readonly receipts: BotIntakeStore,
    @Inject(CHATBOT_REQUEST_COMMAND_STORE)
    private readonly commands: ChatbotRequestCommandStore,
  ) {}

  /** `GET /chatbot-api/scheduling/slots?conversationRef=&lastCustomerMessageAt=` */
  slots(query: Record<string, unknown>): Promise<SlotsAnswer> {
    const ref = query.conversationRef;
    if (typeof ref !== 'string' || !REF.test(ref)) throw invalid();
    const raw = query.lastCustomerMessageAt;
    const hint = raw === undefined ? null : parseRecentInstant(raw, new Date());
    return this.store.slotsForChat(ref, hint);
  }

  /** `GET /chatbot-requests/:id/scheduling/slots` (Q15). */
  staffSlots(requestId: string): Promise<SlotsAnswer> {
    return this.store.slotsForRequest(requestId);
  }

  async botReschedule(input: {
    credentialId: string;
    idempotencyKey: string | undefined;
    requestId: string;
    body: unknown;
  }): Promise<BotRescheduleResponse> {
    const record = exactKeys(input.body, [
      'scheduledFor',
      'lastCustomerMessageAt',
      'triggerWaMessageId',
    ]);
    if (!isUuid(input.idempotencyKey) || !isUuid(input.requestId)) {
      throw invalid();
    }
    const key = input.idempotencyKey;
    const to = parseInstant(record.scheduledFor);
    const last =
      record.lastCustomerMessageAt === undefined
        ? null
        : parseRecentInstant(record.lastCustomerMessageAt, new Date());
    const trigger = record.triggerWaMessageId;
    if (trigger !== undefined && !isToken(trigger)) throw invalid();
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          input.requestId,
          to.toISOString(),
          last?.toISOString() ?? null,
          trigger ?? null,
        ]),
      )
      .digest('hex');

    // A receipt kind of its own (the database CHECK allows 'RESCHEDULE'): the
    // key is the raw `X-Idempotency-Key`, so it can never collide with a create
    // or a cancel receipt.
    return this.receipts.transaction(async () => {
      await this.receipts.lockKey('RESCHEDULE', key);
      const receipt = await this.receipts.findReceipt('RESCHEDULE', key);
      if (receipt) {
        if (receipt.commandHash !== hash) {
          throw new ChatbotRequestCommandError('IDEMPOTENCY_CONFLICT', 409);
        }
        return receipt.responseSnapshot as BotRescheduleResponse;
      }
      const result = await this.store.reschedule({
        requestId: input.requestId,
        to,
        expectedVersion: null,
        lastCustomerMessageAt: last,
        triggerWaMessageId: trigger ?? null,
        actor: { kind: 'SERVICE', id: input.credentialId },
      });
      const response: BotRescheduleResponse = {
        id: result.request.id,
        status: result.request.status,
        outcome: result.outcome,
        scheduledFor: result.scheduledFor.toISOString(),
        previousScheduledFor: result.previousScheduledFor.toISOString(),
        scheduleVersion: result.scheduleVersion,
        requiresTemplateAtStart: result.requiresTemplateAtStart,
        whatsappWindowClosesAt: result.windowClosesAt.toISOString(),
      };
      await this.receipts.saveReceipt(
        'RESCHEDULE',
        key,
        hash,
        result.request.id,
        response,
      );
      return response;
    });
  }

  async staffReschedule(input: {
    requestId: string;
    actorUserId: string;
    idempotencyKey: string;
    expectedVersion: number;
    scheduledFor: string;
  }): Promise<StaffRescheduleView> {
    const to = parseInstant(input.scheduledFor);
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          'reschedule',
          input.requestId,
          input.expectedVersion,
          to.toISOString(),
        ]),
      )
      .digest('hex');
    const view = await withStaffReceipt(
      this.commands,
      input.actorUserId,
      input.idempotencyKey,
      hash,
      async () => {
        const actor = await this.commands.findActor(input.actorUserId);
        if (!actor) throw new ChatbotRequestCommandError('UNAUTHORIZED', 401);
        const result = await this.store.reschedule({
          requestId: input.requestId,
          to,
          expectedVersion: input.expectedVersion,
          lastCustomerMessageAt: null,
          triggerWaMessageId: null,
          actor: {
            kind: 'USER',
            id: actor.userId,
            displayName: actor.displayName,
          },
        });
        const staffView: StaffRescheduleView = {
          ...toRequestView(result.request),
          scheduledFor: result.scheduledFor.toISOString(),
          previousScheduledFor: result.previousScheduledFor.toISOString(),
          scheduleVersion: result.scheduleVersion,
          requiresTemplateAtStart: result.requiresTemplateAtStart,
          customerNotice: { expected: result.customerNoticeExpected },
        };
        return staffView;
      },
    );
    return view as StaffRescheduleView;
  }
}
