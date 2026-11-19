import { defaultSettings } from '../../chatbot-settings/domain/chatbot-attention-settings';
import { policyFromSettings } from './chatbot-sla';
import {
  milestoneKey,
  noticeReleaseAt,
  planSweep,
  slaPauseAt,
  type SweepPlan,
  type SweepRow,
} from './chatbot-sla-sweep';

const at = (v: string) => new Date(v);
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

// Default settings: Mon-Sat 09:00-19:00 America/Mexico_City (UTC-6 in Nov).
// UNKNOWN_QUESTION: claim 30 min, resolve 120 min.
const policy = (
  version = 1,
  mutate?: (s: ReturnType<typeof defaultSettings>) => void,
) => {
  const settings = defaultSettings();
  mutate?.(settings);
  return policyFromSettings(settings, version);
};

const row = (over: Partial<SweepRow> = {}): SweepRow => ({
  subtype: 'UNKNOWN_QUESTION',
  status: 'NEW',
  createdAt: at('2026-11-10T10:00:00-06:00'),
  scheduledFor: null,
  lastReleasedAt: null,
  overdueAt: null,
  assigneeUserId: null,
  slaPolicyVersion: 1,
  ...over,
});

const kinds = (plan: SweepPlan) =>
  plan.milestones.map((m) => [m.milestone, m.notice, m.withAssignee]);

describe('planSweep: milestones of the claim clock (NEW)', () => {
  it('reaches nothing before 50 % and schedules the 50 % instant', () => {
    const plan = planSweep(
      policy(),
      row(),
      new Set(),
      at('2026-11-10T10:10:00-06:00'),
    );
    expect(plan.clock).toBe('CLAIM');
    expect(plan.milestones).toEqual([]);
    expect(iso(plan.nextSlaCheckAt)).toBe(iso(at('2026-11-10T10:15:00-06:00')));
  });

  it('50 % → claim reminder, next is 80 % (24 min)', () => {
    const plan = planSweep(
      policy(),
      row(),
      new Set(),
      at('2026-11-10T10:15:00-06:00'),
    );
    expect(kinds(plan)).toEqual([['HALF', 'REQUEST_CLAIM_REMINDER', false]]);
    expect(iso(plan.nextSlaCheckAt)).toBe(iso(at('2026-11-10T10:24:00-06:00')));
    expect(plan.firstOverdueAt).toBeNull();
  });

  it('80 % → escalation, 100 % → overdue (marks overdueAt at the deadline, feed once)', () => {
    const done = new Set([
      milestoneKey('CLAIM', 'HALF', at('2026-11-10T10:00:00-06:00')),
    ]);
    const esc = planSweep(
      policy(),
      row(),
      done,
      at('2026-11-10T10:24:00-06:00'),
    );
    expect(kinds(esc)).toEqual([['ESCALATION', 'REQUEST_ESCALATION', false]]);
    expect(iso(esc.nextSlaCheckAt)).toBe(iso(at('2026-11-10T10:30:00-06:00')));

    done.add(
      milestoneKey('CLAIM', 'ESCALATION', at('2026-11-10T10:00:00-06:00')),
    );
    const over = planSweep(
      policy(),
      row(),
      done,
      at('2026-11-10T10:30:01-06:00'),
    );
    expect(kinds(over)).toEqual([['OVERDUE', 'REQUEST_OVERDUE', false]]);
    expect(iso(over.firstOverdueAt)).toBe(iso(at('2026-11-10T10:30:00-06:00')));
    expect(over.nextSlaCheckAt).toBeNull();
  });

  it('each milestone is reached once: a recorded one is never planned again', () => {
    const start = at('2026-11-10T10:00:00-06:00');
    const done = new Set([
      milestoneKey('CLAIM', 'HALF', start),
      milestoneKey('CLAIM', 'ESCALATION', start),
      milestoneKey('CLAIM', 'OVERDUE', start),
    ]);
    const plan = planSweep(
      policy(),
      row({ overdueAt: at('2026-11-10T10:30:00-06:00') }),
      done,
      at('2026-11-10T11:00:00-06:00'),
    );
    expect(plan.milestones).toEqual([]);
    expect(plan.firstOverdueAt).toBeNull();
    expect(plan.nextSlaCheckAt).toBeNull();
  });

  it('after downtime records every reached milestone but notifies only the highest', () => {
    const plan = planSweep(
      policy(),
      row(),
      new Set(),
      at('2026-11-10T10:45:00-06:00'),
    );
    expect(kinds(plan)).toEqual([
      ['HALF', null, false],
      ['ESCALATION', null, false],
      ['OVERDUE', 'REQUEST_OVERDUE', false],
    ]);
    expect(plan.firstOverdueAt).not.toBeNull();
  });

  it('a release starts a new claim cycle: the same milestones are reached again', () => {
    const first = at('2026-11-10T10:00:00-06:00');
    const released = at('2026-11-10T11:00:00-06:00');
    const done = new Set([
      milestoneKey('CLAIM', 'HALF', first),
      milestoneKey('CLAIM', 'ESCALATION', first),
      milestoneKey('CLAIM', 'OVERDUE', first),
    ]);
    const plan = planSweep(
      policy(),
      row({
        lastReleasedAt: released,
        overdueAt: at('2026-11-10T10:30:00-06:00'),
      }),
      done,
      at('2026-11-10T11:15:00-06:00'),
    );
    expect(kinds(plan)).toEqual([['HALF', 'REQUEST_CLAIM_REMINDER', false]]);
    // a second cycle's overdue does not feed the bot again: overdueAt is set
    const later = planSweep(
      policy(),
      row({
        lastReleasedAt: released,
        overdueAt: at('2026-11-10T10:30:00-06:00'),
      }),
      new Set([
        ...done,
        milestoneKey('CLAIM', 'HALF', released),
        milestoneKey('CLAIM', 'ESCALATION', released),
      ]),
      at('2026-11-10T11:31:00-06:00'),
    );
    expect(kinds(later)).toEqual([['OVERDUE', 'REQUEST_OVERDUE', false]]);
    expect(later.firstOverdueAt).toBeNull();
  });
});

describe('planSweep: resolve clock (IN_PROGRESS)', () => {
  const claimed = row({
    status: 'IN_PROGRESS',
    assigneeUserId: 'u-1',
  });

  it('50 % is recorded without a notice (the table only has "sin tomar")', () => {
    const plan = planSweep(
      policy(),
      claimed,
      new Set(),
      at('2026-11-10T11:00:00-06:00'),
    );
    expect(plan.clock).toBe('RESOLVE');
    expect(kinds(plan)).toEqual([['HALF', null, true]]);
  });

  it('80 % and overdue go to the assignee as well as to the escalation viewers', () => {
    const start = at('2026-11-10T10:00:00-06:00');
    const done = new Set([milestoneKey('RESOLVE', 'HALF', start)]);
    const esc = planSweep(
      policy(),
      claimed,
      done,
      at('2026-11-10T11:36:00-06:00'),
    );
    expect(kinds(esc)).toEqual([['ESCALATION', 'REQUEST_ESCALATION', true]]);
    done.add(milestoneKey('RESOLVE', 'ESCALATION', start));
    const over = planSweep(
      policy(),
      claimed,
      done,
      at('2026-11-10T12:00:00-06:00'),
    );
    expect(kinds(over)).toEqual([['OVERDUE', 'REQUEST_OVERDUE', true]]);
    expect(iso(over.firstOverdueAt)).toBe(iso(at('2026-11-10T12:00:00-06:00')));
  });

  it('claimed after the resolve deadline with overdueAt from the claim clock: all three recorded, the assignee told once (overdue), no second customer item', () => {
    const lateClaim = row({
      status: 'IN_PROGRESS',
      assigneeUserId: 'u-1',
      overdueAt: at('2026-11-10T10:31:00-06:00'),
    });
    const plan = planSweep(
      policy(),
      lateClaim,
      new Set([
        milestoneKey('CLAIM', 'HALF', at('2026-11-10T10:00:00-06:00')),
        milestoneKey('CLAIM', 'ESCALATION', at('2026-11-10T10:00:00-06:00')),
        milestoneKey('CLAIM', 'OVERDUE', at('2026-11-10T10:00:00-06:00')),
      ]),
      at('2026-11-10T13:00:00-06:00'),
    );
    expect(plan.clock).toBe('RESOLVE');
    expect(kinds(plan)).toEqual([
      ['HALF', null, true],
      ['ESCALATION', null, true],
      ['OVERDUE', 'REQUEST_OVERDUE', true],
    ]);
    // the customer overdue item stays once per request
    expect(plan.firstOverdueAt).toBeNull();
    expect(plan.customerNotice).toBeNull();
    expect(plan.nextSlaCheckAt).toBeNull();
  });

  it('claiming does not reset the resolve cycle (same clock, same keys)', () => {
    const start = at('2026-11-10T10:00:00-06:00');
    const done = new Set([milestoneKey('RESOLVE', 'HALF', start)]);
    const plan = planSweep(
      policy(),
      claimed,
      done,
      at('2026-11-10T11:10:00-06:00'),
    );
    expect(plan.milestones).toEqual([]);
  });

  it('a request without any deadline has no clock and no next check', () => {
    const plan = planSweep(
      policy(),
      row({
        subtype: 'TRANSFER_RECEIPT',
        createdAt: at('2026-11-10T10:00:00-06:00'),
      }),
      new Set(),
      at('2026-11-10T10:00:00-06:00'),
    );
    // receipt: no claim minutes, receipt rule deadline 19:00 → resolve clock
    expect(plan.clock).toBe('RESOLVE');
    expect(iso(plan.nextSlaCheckAt)).toBe(iso(at('2026-11-10T14:30:00-06:00')));
    const none = planSweep(
      policy(1, (s) => {
        s.slas = s.slas.map((e) =>
          e.subtype === 'UNKNOWN_QUESTION'
            ? { ...e, claimMinutes: null, resolveMinutes: null }
            : e,
        );
      }),
      row(),
      new Set(),
      at('2026-11-10T10:00:00-06:00'),
    );
    expect(none.clock).toBeNull();
    expect(none.nextSlaCheckAt).toBeNull();
  });
});

describe('planSweep: business hours', () => {
  it('Saturday night to Monday: the next check is business time on Monday, no notice while paused', () => {
    const created = at('2026-11-14T18:50:00-06:00'); // Saturday, 10 min before close
    const r = row({ createdAt: created });
    const sat = planSweep(
      policy(),
      r,
      new Set(),
      at('2026-11-14T18:55:00-06:00'),
    );
    // 50 % of 30 = 15 business min → Monday 09:05
    expect(sat.milestones).toEqual([]);
    expect(iso(sat.nextSlaCheckAt)).toBe(iso(at('2026-11-16T09:05:00-06:00')));
    // still closed on Sunday: nothing reached
    const sun = planSweep(
      policy(),
      r,
      new Set(),
      at('2026-11-15T12:00:00-06:00'),
    );
    expect(sun.milestones).toEqual([]);
    const mon = planSweep(
      policy(),
      r,
      new Set(),
      at('2026-11-16T09:05:00-06:00'),
    );
    expect(kinds(mon)).toEqual([['HALF', 'REQUEST_CLAIM_REMINDER', false]]);
  });

  it('a closed date in the middle is skipped', () => {
    const created = at('2026-11-13T18:50:00-06:00'); // Friday
    const p = policy(1, (s) => {
      s.closedDates = ['2026-11-14'];
    });
    const plan = planSweep(p, row({ createdAt: created }), new Set(), created);
    // 15 min: 10 on Friday, 5 on Monday? Saturday closed, Sunday closed → Monday 09:05
    expect(iso(plan.nextSlaCheckAt)).toBe(iso(at('2026-11-16T09:05:00-06:00')));
  });

  it('crosses the DST change in New York with real business minutes', () => {
    const ny = (s: ReturnType<typeof defaultSettings>) => {
      s.openingHours = {
        timeZone: 'America/New_York',
        days: s.openingHours.days.map((d) => ({
          day: d.day,
          ranges: d.day === 'SUNDAY' ? [] : [{ open: '09:00', close: '17:00' }],
        })),
      };
    };
    // Saturday 2027-03-13 16:30 EST (UTC-5); DST starts Sunday 03-14 02:00.
    const created = at('2027-03-13T16:30:00-05:00');
    const r = row({ createdAt: created });
    const plan = planSweep(policy(1, ny), r, new Set(), created);
    // 50 % = 15 min → 16:45 Saturday; 80 % = 24 → 16:54
    expect(iso(plan.nextSlaCheckAt)).toBe(iso(at('2027-03-13T16:45:00-05:00')));
    const done = new Set([
      milestoneKey('CLAIM', 'HALF', created),
      milestoneKey('CLAIM', 'ESCALATION', created),
    ]);
    // overdue = 30 business min: 30 on Saturday up to 17:00, i.e. the close
    const over = planSweep(
      policy(1, ny),
      r,
      done,
      at('2027-03-13T17:00:00-05:00'),
    );
    expect(kinds(over)).toEqual([['OVERDUE', 'REQUEST_OVERDUE', false]]);
    // Monday after the DST change: 09:00 EDT is 13:00Z, not 14:00Z
    const monday = row({ createdAt: at('2027-03-13T16:50:00-05:00') });
    const mon = planSweep(
      policy(1, ny),
      monday,
      new Set(),
      at('2027-03-13T16:50:00-05:00'),
    );
    // 10 min Saturday, 5 min Monday (HALF at 15): Monday 09:05 EDT = 13:05Z
    expect(iso(mon.nextSlaCheckAt)).toBe(
      '2027-03-13T16:55:00.000Z'.replace(
        '2027-03-13T16:55',
        '2027-03-15T13:05',
      ),
    );
  });

  it('an overdue that lands exactly on the close still fires (closed at that instant)', () => {
    const created = at('2026-11-10T18:30:00-06:00');
    const start = created;
    const done = new Set([
      milestoneKey('CLAIM', 'HALF', start),
      milestoneKey('CLAIM', 'ESCALATION', start),
    ]);
    const plan = planSweep(
      policy(),
      row({ createdAt: created }),
      done,
      at('2026-11-10T19:00:00-06:00'),
    );
    expect(kinds(plan)).toEqual([['OVERDUE', 'REQUEST_OVERDUE', false]]);
  });
});

describe('planSweep: stale policy', () => {
  it('recomputes the deadlines of a row on an older version and plans with the new ones', () => {
    // settings changed: claim 30 → 60 min, version 2. Row stamped 1.
    const p = policy(2, (s) => {
      s.slas = s.slas.map((e) =>
        e.subtype === 'UNKNOWN_QUESTION' ? { ...e, claimMinutes: 60 } : e,
      );
    });
    const plan = planSweep(
      p,
      row({ slaPolicyVersion: 1 }),
      new Set(),
      at('2026-11-10T10:20:00-06:00'),
    );
    expect(plan.stale).toBe(true);
    expect(plan.columns?.slaPolicyVersion).toBe(2);
    expect(iso(plan.columns?.claimDeadlineAt)).toBe(
      iso(at('2026-11-10T11:00:00-06:00')),
    );
    // under 60 min, 50 % is 10:30: not reached at 10:20
    expect(plan.milestones).toEqual([]);
    expect(iso(plan.nextSlaCheckAt)).toBe(iso(at('2026-11-10T10:30:00-06:00')));
  });

  it('a null version is stale; a current version is not and writes no columns', () => {
    expect(
      planSweep(
        policy(),
        row({ slaPolicyVersion: null }),
        new Set(),
        at('2026-11-10T10:00:00-06:00'),
      ).stale,
    ).toBe(true);
    const fresh = planSweep(
      policy(),
      row(),
      new Set(),
      at('2026-11-10T10:00:00-06:00'),
    );
    expect(fresh.stale).toBe(false);
    expect(fresh.columns).toBeNull();
  });

  it('a milestone already recorded is not repeated when the new policy moved its instant', () => {
    const start = at('2026-11-10T10:00:00-06:00');
    const done = new Set([milestoneKey('CLAIM', 'HALF', start)]);
    const p = policy(2, (s) => {
      s.slas = s.slas.map((e) =>
        e.subtype === 'UNKNOWN_QUESTION' ? { ...e, claimMinutes: 20 } : e,
      );
    });
    const plan = planSweep(
      p,
      row({ slaPolicyVersion: 1 }),
      done,
      at('2026-11-10T10:12:00-06:00'),
    );
    expect(plan.milestones).toEqual([]);
    expect(iso(plan.nextSlaCheckAt)).toBe(iso(at('2026-11-10T10:16:00-06:00')));
  });
});

describe('planSweep: 50 % of a claimed request sends no notice (owner decision L69)', () => {
  it('records HALF of the resolve clock with notice null, for the assignee or not', () => {
    const plan = planSweep(
      policy(),
      row({ status: 'IN_PROGRESS', assigneeUserId: 'u-1' }),
      new Set(),
      at('2026-11-10T11:00:00-06:00'),
    );
    expect(plan.milestones).toHaveLength(1);
    expect(plan.milestones[0]).toMatchObject({
      milestone: 'HALF',
      notice: null,
    });
  });
});

describe('planSweep: customer notice of the first overdue (24 h rule, owner decision L69)', () => {
  const start = at('2026-11-10T10:00:00-06:00');
  const done = new Set([
    milestoneKey('CLAIM', 'HALF', start),
    milestoneKey('CLAIM', 'ESCALATION', start),
  ]);
  // The claim deadline is 10:30 -06:00 = 16:30Z.
  const deadline = at('2026-11-10T10:30:00-06:00').getTime();
  const plan = (sinceDeadlineMs: number, overdueAt: Date | null = null) =>
    planSweep(
      policy(),
      row({ overdueAt }),
      done,
      new Date(deadline + sinceDeadlineMs),
    );
  const HOUR = 3_600_000;

  it('just under 24 h: the customer is told', () => {
    const p = plan(24 * HOUR - 1);
    expect(p.firstOverdueAt).not.toBeNull();
    expect(p.customerNotice).toBe('SENT');
  });

  it('at exactly 24 h: skipped as stale, but overdueAt is still marked', () => {
    const p = plan(24 * HOUR);
    expect(iso(p.firstOverdueAt)).toBe(iso(new Date(deadline)));
    expect(p.customerNotice).toBe('SKIPPED_STALE');
  });

  it('over 24 h: skipped as stale, the staff notice is still planned', () => {
    const p = plan(24 * HOUR + 1);
    expect(p.customerNotice).toBe('SKIPPED_STALE');
    expect(kinds(p)).toEqual([['OVERDUE', 'REQUEST_OVERDUE', false]]);
  });

  it('is only decided on the first overdue of the request', () => {
    expect(
      plan(1000, at('2026-11-10T10:00:00-06:00')).customerNotice,
    ).toBeNull();
    expect(
      plan(1000, at('2026-11-10T10:00:00-06:00')).firstOverdueAt,
    ).toBeNull();
    // not overdue yet: nothing
    expect(plan(-1000).customerNotice).toBeNull();
  });
});

describe('slaPauseAt and noticeReleaseAt: staff notices wait for the next opening', () => {
  const cal = (mutate?: (s: ReturnType<typeof defaultSettings>) => void) =>
    policy(1, mutate).calendar;

  it('open: nothing to wait for', () => {
    const c = cal();
    const now = at('2026-11-10T12:00:00-06:00');
    expect(slaPauseAt(c, now)).toEqual({ paused: false, resumesAt: null });
    expect(noticeReleaseAt(c, now)).toBeNull();
  });

  it('Saturday 19:00 (the close) → Monday 09:00; Sunday is closed', () => {
    const c = cal();
    expect(iso(noticeReleaseAt(c, at('2026-11-14T19:00:00-06:00')))).toBe(
      iso(at('2026-11-16T09:00:00-06:00')),
    );
    expect(iso(noticeReleaseAt(c, at('2026-11-15T03:00:00-06:00')))).toBe(
      iso(at('2026-11-16T09:00:00-06:00')),
    );
  });

  it('before the opening the notice waits for that same day', () => {
    expect(iso(noticeReleaseAt(cal(), at('2026-11-10T07:00:00-06:00')))).toBe(
      iso(at('2026-11-10T09:00:00-06:00')),
    );
  });

  it('a closed date in between pushes the release to the next business day', () => {
    const c = cal((s) => {
      s.closedDates = ['2026-11-16'];
    });
    expect(iso(noticeReleaseAt(c, at('2026-11-14T19:00:00-06:00')))).toBe(
      iso(at('2026-11-17T09:00:00-06:00')),
    );
    // closed date during the week
    expect(iso(noticeReleaseAt(c, at('2026-11-16T12:00:00-06:00')))).toBe(
      iso(at('2026-11-17T09:00:00-06:00')),
    );
  });

  it('a calendar with no business time inside its horizon releases immediately (null), never throws', () => {
    // Documented choice: with no next opening there is nothing to wait for, so
    // the notice is not held back (a held notice would never be released). A
    // week with no range at all cannot be built; the reachable case is every
    // open weekday closed by closedDates for longer than the 800-day horizon.
    const mondays: string[] = [];
    for (let week = 0; week < 120; week++) {
      mondays.push(
        new Date(Date.UTC(2026, 10, 9 + week * 7)).toISOString().slice(0, 10),
      );
    }
    const closedForever = cal((s) => {
      s.openingHours = {
        timeZone: s.openingHours.timeZone,
        days: s.openingHours.days.map((d) => ({
          day: d.day,
          ranges: d.day === 'MONDAY' ? [{ open: '09:00', close: '19:00' }] : [],
        })),
      };
      s.closedDates = mondays;
    });
    const now = at('2026-11-10T12:00:00-06:00');
    expect(slaPauseAt(closedForever, now)).toEqual({
      paused: true,
      resumesAt: null,
    });
    expect(noticeReleaseAt(closedForever, now)).toBeNull();
  });

  it('crosses the DST change: Monday 09:00 EDT is 13:00Z, not 14:00Z', () => {
    const ny = cal((s) => {
      s.openingHours = {
        timeZone: 'America/New_York',
        days: s.openingHours.days.map((d) => ({
          day: d.day,
          ranges: d.day === 'SUNDAY' ? [] : [{ open: '09:00', close: '17:00' }],
        })),
      };
    });
    // Saturday 2027-03-13 17:00 EST (22:00Z); DST starts Sunday 02:00.
    expect(iso(noticeReleaseAt(ny, at('2027-03-13T17:00:00-05:00')))).toBe(
      '2027-03-15T13:00:00.000Z',
    );
  });
});
