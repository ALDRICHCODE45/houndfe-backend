/**
 * Unit 14: the pure rules of the schedule sweep (reminder 10 min before, never
 * under 3 min, suppressed while `needsReschedule`; the "solicitud nueva" notice
 * at `scheduledFor`). Injected clock only.
 */
import { createBusinessCalendar } from './business-hours-calendar';
import {
  MIN_REMINDER_REMAINING_MINUTES,
  isStartStillOpen,
  planScheduleStep,
} from './schedule-sweep';

const MIN = 60_000;
const AT = new Date('2026-11-16T15:00:00.000Z');
const at = (minutesFromStart: number) =>
  new Date(AT.getTime() + minutesFromStart * MIN);
const base = {
  stage: 0,
  scheduledFor: AT,
  status: 'NEW',
  needsReschedule: false,
};

describe('planScheduleStep', () => {
  it('stage 0 on time: the reminder, then wait for scheduledFor', () => {
    expect(planScheduleStep({ ...base, now: at(-10) })).toEqual({
      reminder: true,
      notice: false,
      stage: 1,
      dueAt: AT,
    });
  });

  it('keeps the reminder while at least 3 minutes remain, drops it below', () => {
    expect(MIN_REMINDER_REMAINING_MINUTES).toBe(3);
    expect(planScheduleStep({ ...base, now: at(-3) }).reminder).toBe(true);
    const late = planScheduleStep({ ...base, now: at(-2.99) });
    expect(late).toMatchObject({ reminder: false, stage: 1, dueAt: AT });
  });

  it('a sweep that ran after scheduledFor sends no reminder and goes on to the notice', () => {
    expect(planScheduleStep({ ...base, now: at(4) })).toEqual({
      reminder: false,
      notice: true,
      stage: 2,
      dueAt: null,
    });
  });

  it('suppresses the reminder while needsReschedule is set, the notice still comes', () => {
    const flagged = { ...base, needsReschedule: true };
    expect(planScheduleStep({ ...flagged, now: at(-10) }).reminder).toBe(false);
    expect(planScheduleStep({ ...flagged, stage: 1, now: at(0) })).toEqual({
      reminder: false,
      notice: true,
      stage: 2,
      dueAt: null,
    });
  });

  it('stage 1 at scheduledFor: the notice and done', () => {
    expect(planScheduleStep({ ...base, stage: 1, now: at(0) })).toEqual({
      reminder: false,
      notice: true,
      stage: 2,
      dueAt: null,
    });
  });

  it('a request already claimed gets neither (someone is attending it)', () => {
    expect(
      planScheduleStep({ ...base, status: 'IN_PROGRESS', now: at(-10) }),
    ).toMatchObject({ reminder: false });
    expect(
      planScheduleStep({
        ...base,
        status: 'IN_PROGRESS',
        stage: 1,
        now: at(0),
      }),
    ).toEqual({ reminder: false, notice: false, stage: 2, dueAt: null });
  });

  it('a closed request is settled without output', () => {
    for (const status of ['RESOLVED', 'CANCELLED']) {
      expect(planScheduleStep({ ...base, status, now: at(-10) })).toEqual({
        reminder: false,
        notice: false,
        stage: 2,
        dueAt: null,
      });
    }
  });
});

describe('isStartStillOpen', () => {
  const open = (closedDates: string[] = [], close = '19:00') =>
    createBusinessCalendar({
      timeZone: 'America/Mexico_City',
      closedDates,
      days: [
        'MONDAY',
        'TUESDAY',
        'WEDNESDAY',
        'THURSDAY',
        'FRIDAY',
        'SATURDAY',
        'SUNDAY',
      ].map((day) => ({ day, ranges: [{ open: '09:00', close }] })) as never,
    });
  // 2026-11-16 09:00 Mexico City (UTC-6) = 15:00Z
  it('is true inside an open range and false on a closed date or after a shortened close', () => {
    expect(isStartStillOpen(open(), AT)).toBe(true);
    expect(isStartStillOpen(open(['2026-11-16']), AT)).toBe(false);
    const evening = new Date('2026-11-17T00:30:00.000Z'); // 18:30 local
    expect(isStartStillOpen(open(), evening)).toBe(true);
    expect(isStartStillOpen(open([], '18:00'), evening)).toBe(false);
  });
});
