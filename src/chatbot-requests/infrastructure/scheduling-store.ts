/**
 * Scheduling persistence (human-intervention unit 14; contract §4.9, §10.1
 * "Agenda"). Raw SQL with an explicit `tenantId` on every statement, so it runs
 * on a request's tenant client and on the sweep's root client alike.
 *
 *   `loadSchedulingConfig`  the tenant's calendar and scheduling settings. The
 *                           calendar is memoized by `(tenant, settings version)`,
 *                           so the hot listing path pays one primary-key read of
 *                           the settings row and never rebuilds a calendar.
 *   `readFullBlocks`        the blocks with no seat left in a range: a range
 *                           read of the counter's primary key.
 *   `reserveSeat`           ONE atomic upsert that refuses to pass the limit: the
 *                           row lock serializes two bookings for the last seat,
 *                           so exactly one wins (no SELECT-then-INSERT race).
 *   `releaseSeat`           gives a seat back (cancel, or the old side of a move).
 *   `moveSeat`              release + reserve with the two rows touched in
 *                           ascending `startsAt` order, so two moves in opposite
 *                           directions cannot deadlock.
 *
 * Lock order (docs/chatbot-requests-model.md): request row, then counter rows,
 * then the customer group. A booking has no request row yet (customer lock,
 * counter, folio, insert, group).
 */
import { Prisma } from '@prisma/client';
import {
  defaultSettings,
  type AttentionSettings,
} from '../../chatbot-settings/domain/chatbot-attention-settings';
import {
  createBusinessCalendar,
  type BusinessCalendar,
} from '../domain/business-hours-calendar';
import {
  readSettingsRow,
  rowToSettings,
  type RawDb,
} from './chatbot-sla-policy';

export interface SchedulingConfig {
  version: number;
  settings: AttentionSettings;
  calendar: BusinessCalendar;
}

const CALENDARS = new Map<string, BusinessCalendar>();
const MAX_CACHED = 500;

function calendarFor(
  tenantId: string,
  version: number,
  settings: AttentionSettings,
): BusinessCalendar {
  const key = `${tenantId}:${version}`;
  const cached = CALENDARS.get(key);
  if (cached) return cached;
  const calendar = createBusinessCalendar({
    timeZone: settings.openingHours.timeZone,
    days: settings.openingHours.days,
    closedDates: settings.closedDates,
  });
  if (CALENDARS.size >= MAX_CACHED) CALENDARS.clear();
  CALENDARS.set(key, calendar);
  return calendar;
}

/**
 * With `lock: 'SHARE'` inside a transaction a concurrent settings `PUT` waits
 * for the booking, so the recompute that follows it always sees the booking
 * (the same rule `loadSlaPolicy` follows).
 */
export async function loadSchedulingConfig(
  db: RawDb,
  tenantId: string,
  lock?: 'SHARE',
): Promise<SchedulingConfig> {
  const row = await readSettingsRow(db, tenantId, lock);
  const version = row?.version ?? 0;
  const settings = row ? rowToSettings(row) : defaultSettings();
  return {
    version,
    settings,
    calendar: calendarFor(tenantId, version, settings),
  };
}

/** `startsAt` (epoch ms) of every block in `[from, to)` whose seats are all taken. */
export async function readFullBlocks(
  db: RawDb,
  tenantId: string,
  from: Date,
  to: Date,
  max: number,
): Promise<Set<number>> {
  const rows = await db.$queryRaw<Array<{ startsAt: Date }>>(Prisma.sql`
    SELECT "startsAt" FROM "scheduled_slot_counters"
    WHERE "tenantId" = ${tenantId} AND "startsAt" >= ${from}
      AND "startsAt" < ${to} AND "booked" >= ${max}`);
  return new Set(rows.map((row) => row.startsAt.getTime()));
}

/** `true` when a seat was taken, `false` when the block is full. */
export async function reserveSeat(
  db: RawDb,
  tenantId: string,
  startsAt: Date,
  max: number,
): Promise<boolean> {
  if (max < 1) return false;
  const rows = await db.$queryRaw<Array<{ booked: number }>>(Prisma.sql`
    INSERT INTO "scheduled_slot_counters" ("tenantId", "startsAt", "booked")
    VALUES (${tenantId}, ${startsAt}, 1)
    ON CONFLICT ("tenantId", "startsAt") DO UPDATE
      SET "booked" = "scheduled_slot_counters"."booked" + 1
      WHERE "scheduled_slot_counters"."booked" < ${max}
    RETURNING "booked"`);
  return rows.length === 1;
}

export async function releaseSeat(
  db: RawDb,
  tenantId: string,
  startsAt: Date,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE "scheduled_slot_counters" SET "booked" = "booked" - 1
    WHERE "tenantId" = ${tenantId} AND "startsAt" = ${startsAt}
      AND "booked" > 0`);
}

/** Moves a seat; `false` (nothing changed in this call's effects) if `to` is full. */
export async function moveSeat(
  db: RawDb,
  tenantId: string,
  from: Date,
  to: Date,
  max: number,
): Promise<boolean> {
  if (from.getTime() === to.getTime()) return true;
  if (from.getTime() < to.getTime()) {
    await releaseSeat(db, tenantId, from);
    return reserveSeat(db, tenantId, to, max);
  }
  if (!(await reserveSeat(db, tenantId, to, max))) return false;
  await releaseSeat(db, tenantId, from);
  return true;
}
