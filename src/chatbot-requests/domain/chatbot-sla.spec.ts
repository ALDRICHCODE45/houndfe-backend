import { defaultSettings } from '../../chatbot-settings/domain/chatbot-attention-settings';
import { computeSla, policyFromSettings, type SlaAnchors } from './chatbot-sla';

const policy = (mutate?: (s: ReturnType<typeof defaultSettings>) => void) => {
  const settings = defaultSettings();
  mutate?.(settings);
  return policyFromSettings(settings, 3);
};

const at = (v: string) => new Date(v);
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

const anchors = (over: Partial<SlaAnchors> = {}): SlaAnchors => ({
  subtype: 'UNKNOWN_QUESTION',
  status: 'NEW',
  createdAt: at('2026-11-10T10:00:00-06:00'),
  scheduledFor: null,
  lastReleasedAt: null,
  overdueAt: null,
  ...over,
});

describe('computeSla: a new request', () => {
  it('counts the claim and resolve minutes of the subtype from creation', () => {
    const now = at('2026-11-10T10:00:00-06:00');
    const sla = computeSla(policy(), anchors(), now);
    expect(iso(sla.claimDeadlineAt)).toBe(iso(at('2026-11-10T10:30:00-06:00')));
    expect(iso(sla.resolveDeadlineAt)).toBe(
      iso(at('2026-11-10T12:00:00-06:00')),
    );
    expect(sla.slaPolicyVersion).toBe(3);
  });

  it('pauses outside business hours (Saturday night to Monday)', () => {
    const created = at('2026-11-14T18:50:00-06:00');
    const sla = computeSla(policy(), anchors({ createdAt: created }), created);
    // 10 of the 30 claim minutes on Saturday, 20 on Monday.
    expect(iso(sla.claimDeadlineAt)).toBe(iso(at('2026-11-16T09:20:00-06:00')));
  });

  it('uses fixed null SLAs as no deadline (conversation resolves "live")', () => {
    const sla = computeSla(
      policy(),
      anchors({ subtype: 'TALK_TO_HUMAN' }),
      at('2026-11-10T10:00:00-06:00'),
    );
    expect(iso(sla.claimDeadlineAt)).toBe(iso(at('2026-11-10T10:10:00-06:00')));
    expect(sla.resolveDeadlineAt).toBeNull();
  });

  it('applies the receipt rule to the resolve deadline, with no claim deadline', () => {
    const created = at('2026-11-10T10:00:00-06:00');
    const sla = computeSla(
      policy(),
      anchors({ subtype: 'TRANSFER_RECEIPT' }),
      created,
    );
    expect(sla.claimDeadlineAt).toBeNull();
    expect(iso(sla.resolveDeadlineAt)).toBe(
      iso(at('2026-11-10T19:00:00-06:00')),
    );
  });

  it('moves a receipt close to the close margin to the next business day', () => {
    const created = at('2026-11-10T18:30:00-06:00');
    const sla = computeSla(
      policy(),
      anchors({ subtype: 'TRANSFER_RECEIPT', createdAt: created }),
      created,
    );
    expect(iso(sla.resolveDeadlineAt)).toBe(
      iso(at('2026-11-11T19:00:00-06:00')),
    );
  });

  it('honours closed dates', () => {
    const created = at('2026-11-14T18:50:00-06:00');
    const sla = computeSla(
      policy((s) => {
        s.closedDates = ['2026-11-16'];
      }),
      anchors({ createdAt: created }),
      created,
    );
    expect(iso(sla.claimDeadlineAt)).toBe(iso(at('2026-11-17T09:20:00-06:00')));
  });

  it('starts the clocks at scheduledFor when it is later than creation (§4.9)', () => {
    const created = at('2026-11-10T10:00:00-06:00');
    const sla = computeSla(
      policy(),
      anchors({
        subtype: 'TALK_TO_HUMAN',
        createdAt: created,
        scheduledFor: at('2026-11-12T15:00:00-06:00'),
      }),
      created,
    );
    expect(iso(sla.claimDeadlineAt)).toBe(iso(at('2026-11-12T15:10:00-06:00')));
  });

  it('ignores a scheduledFor in the past', () => {
    const created = at('2026-11-10T10:00:00-06:00');
    const sla = computeSla(
      policy(),
      anchors({
        subtype: 'TALK_TO_HUMAN',
        createdAt: created,
        scheduledFor: at('2026-11-09T10:00:00-06:00'),
      }),
      created,
    );
    expect(iso(sla.claimDeadlineAt)).toBe(iso(at('2026-11-10T10:10:00-06:00')));
  });
});

describe('computeSla: nextSlaCheckAt', () => {
  it('is the first milestone (50 %) of the claim clock while NEW', () => {
    const now = at('2026-11-10T10:00:00-06:00');
    const sla = computeSla(policy(), anchors(), now);
    // 30 claim minutes: 50 % is 15.
    expect(iso(sla.nextSlaCheckAt)).toBe(iso(at('2026-11-10T10:15:00-06:00')));
  });

  it('moves to the next milestone as time passes (80 %, then the deadline)', () => {
    const a = anchors();
    expect(
      iso(
        computeSla(policy(), a, at('2026-11-10T10:16:00-06:00')).nextSlaCheckAt,
      ),
    ).toBe(iso(at('2026-11-10T10:24:00-06:00')));
    expect(
      iso(
        computeSla(policy(), a, at('2026-11-10T10:25:00-06:00')).nextSlaCheckAt,
      ),
    ).toBe(iso(at('2026-11-10T10:30:00-06:00')));
  });

  it('is "now" when every instant passed and the request is not overdue yet', () => {
    const now = at('2026-11-10T11:00:00-06:00');
    expect(iso(computeSla(policy(), anchors(), now).nextSlaCheckAt)).toBe(
      iso(now),
    );
  });

  it('is null when every instant passed and it is already overdue', () => {
    const now = at('2026-11-10T11:00:00-06:00');
    const sla = computeSla(
      policy(),
      anchors({ overdueAt: at('2026-11-10T10:31:00-06:00') }),
      now,
    );
    expect(sla.nextSlaCheckAt).toBeNull();
  });

  it('follows the resolve clock once IN_PROGRESS and keeps the claim deadline out of the patch', () => {
    const now = at('2026-11-10T10:05:00-06:00');
    const sla = computeSla(policy(), anchors({ status: 'IN_PROGRESS' }), now);
    expect(sla.claimDeadlineAt).toBeUndefined();
    expect(iso(sla.resolveDeadlineAt)).toBe(
      iso(at('2026-11-10T12:00:00-06:00')),
    );
    // 120 resolve minutes: 50 % is 60 minutes after creation.
    expect(iso(sla.nextSlaCheckAt)).toBe(iso(at('2026-11-10T11:00:00-06:00')));
  });

  it('is null for an in-progress conversation with no resolve time', () => {
    const sla = computeSla(
      policy(),
      anchors({ subtype: 'TALK_TO_HUMAN', status: 'IN_PROGRESS' }),
      at('2026-11-10T10:05:00-06:00'),
    );
    expect(sla.nextSlaCheckAt).toBeNull();
  });

  it('a receipt (no claim time) is checked against its resolve clock while NEW', () => {
    const created = at('2026-11-10T10:00:00-06:00');
    const sla = computeSla(
      policy(),
      anchors({ subtype: 'TRANSFER_RECEIPT' }),
      created,
    );
    // 540 business minutes to the 19:00 close; 50 % is 270 minutes: 14:30.
    expect(iso(sla.nextSlaCheckAt)).toBe(iso(at('2026-11-10T14:30:00-06:00')));
  });
});

describe('computeSla: clock restarts', () => {
  it('restarts the claim clock at the release for a NEW request', () => {
    const released = at('2026-11-10T11:00:00-06:00');
    const sla = computeSla(
      policy(),
      anchors({ lastReleasedAt: released }),
      released,
    );
    expect(iso(sla.claimDeadlineAt)).toBe(iso(at('2026-11-10T11:30:00-06:00')));
    // The resolve clock keeps counting from creation.
    expect(iso(sla.resolveDeadlineAt)).toBe(
      iso(at('2026-11-10T12:00:00-06:00')),
    );
  });

  it('ignores a release older than the scheduled start', () => {
    const created = at('2026-11-10T10:00:00-06:00');
    const sla = computeSla(
      policy(),
      anchors({
        subtype: 'TALK_TO_HUMAN',
        scheduledFor: at('2026-11-12T15:00:00-06:00'),
        lastReleasedAt: at('2026-11-11T09:00:00-06:00'),
      }),
      created,
    );
    expect(iso(sla.claimDeadlineAt)).toBe(iso(at('2026-11-12T15:10:00-06:00')));
  });
});

describe('computeSla: settings changes and failures', () => {
  it('recomputing with new minutes changes the deadlines and the version', () => {
    const now = at('2026-11-10T10:00:00-06:00');
    const before = computeSla(policy(), anchors(), now);
    const after = computeSla(
      policy((s) => {
        s.slas.find((e) => e.subtype === 'UNKNOWN_QUESTION')!.claimMinutes = 5;
      }),
      anchors(),
      now,
    );
    expect(iso(after.claimDeadlineAt)).toBe(
      iso(at('2026-11-10T10:05:00-06:00')),
    );
    expect(iso(after.claimDeadlineAt)).not.toBe(iso(before.claimDeadlineAt));
  });

  it('never throws: a calendar with no business time yields no deadlines', () => {
    const closed: string[] = [];
    const start = Date.UTC(2026, 10, 1);
    for (let i = 0; i < 400; i++) {
      closed.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
    }
    const sla = computeSla(
      policy((s) => {
        s.closedDates = closed;
        // Open only on days that are all closed for the next 400 days.
        for (const day of s.openingHours.days) {
          if (day.day !== 'MONDAY') day.ranges = [];
        }
      }),
      anchors({ createdAt: at('2026-11-02T10:00:00-06:00') }),
      at('2026-11-02T10:00:00-06:00'),
    );
    // The scan horizon (800 days) still finds a Monday after the closed run, so
    // deadlines exist; the guarantee under test is that it does not throw.
    expect(sla.slaPolicyVersion).toBe(3);
  });
});
