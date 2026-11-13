/**
 * Slot listing and the `SLOT_UNAVAILABLE` answer (human-intervention unit 14;
 * contract "Scheduled conversations"). Shared by the slots routes, the booking
 * and both reschedules, so every refusal carries the same fresh list.
 */
import { ChatbotRequestCommandError } from '../application/chatbot-request-commands.service';
import {
  HORIZON_DAYS,
  listBookable,
  MIN_LEAD_MINUTES,
  offerSlots,
  STAFF_SLOTS_LIMIT,
  type Slot,
} from '../domain/scheduling';
import { slotViews } from '../domain/scheduling-view';
import type { RawDb } from './chatbot-sla-policy';
import { readFullBlocks, type SchedulingConfig } from './scheduling-store';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** What the bot is offered (`slotsOffered`, window first) or staff's picker. */
export async function freshSlots(
  db: RawDb,
  tenantId: string,
  config: SchedulingConfig,
  now: Date,
  windowClosesAt: Date,
  mode: 'OFFER' | 'PICKER',
): Promise<Slot[]> {
  const { scheduling } = config.settings;
  const full = await readFullBlocks(
    db,
    tenantId,
    new Date(now.getTime() + MIN_LEAD_MINUTES * MINUTE),
    new Date(now.getTime() + HORIZON_DAYS * DAY),
    scheduling.maxScheduledPerSlot,
  );
  const base = {
    calendar: config.calendar,
    slotMinutes: scheduling.slotMinutes,
    now,
    windowClosesAt,
    full,
  };
  return mode === 'OFFER'
    ? offerSlots({ ...base, slotsOffered: scheduling.slotsOffered })
    : listBookable({ ...base, limit: STAFF_SLOTS_LIMIT });
}

/** `409 SLOT_UNAVAILABLE {slots, timeZone, whatsappWindowClosesAt}`. */
export async function slotUnavailable(
  db: RawDb,
  tenantId: string,
  config: SchedulingConfig,
  now: Date,
  windowClosesAt: Date,
  current?: ChatbotRequestCommandError['current'],
): Promise<ChatbotRequestCommandError> {
  const slots = await freshSlots(
    db,
    tenantId,
    config,
    now,
    windowClosesAt,
    'OFFER',
  );
  return new ChatbotRequestCommandError('SLOT_UNAVAILABLE', 409, current, {
    slots: slotViews(slots),
    timeZone: config.calendar.timeZone,
    whatsappWindowClosesAt: windowClosesAt.toISOString(),
  });
}
