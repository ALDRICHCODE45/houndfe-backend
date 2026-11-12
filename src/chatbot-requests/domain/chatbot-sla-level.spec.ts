/**
 * S8: `slaLevel` of an open request, in BUSINESS time, from the same active
 * clock and instants the SLA sweep records milestones from (50 %, 80 %,
 * overdue). Schedule: the defaults, Mon-Sat 09:00-19:00 America/Mexico_City
 * (UTC-6 in November).
 */
import { defaultSettings } from '../../chatbot-settings/domain/chatbot-attention-settings';
import { BusinessCalendarError } from './business-hours-calendar';
import {
  activeClock,
  policyFromSettings,
  slaLevel,
  type SlaAnchors,
  type SlaLevel,
} from './chatbot-sla';

const at = (v: string) => new Date(v);
const policy = () => policyFromSettings(defaultSettings(), 1);

const anchors = (over: Partial<SlaAnchors> = {}): SlaAnchors => ({
  subtype: 'UNKNOWN_QUESTION',
  status: 'NEW',
  createdAt: at('2026-11-10T10:00:00-06:00'),
  scheduledFor: null,
  lastReleasedAt: null,
  overdueAt: null,
  ...over,
});

const levelAt = (a: SlaAnchors, now: string): SlaLevel | null =>
  slaLevel(policy(), a, at(now));

describe('slaLevel', () => {
  it('claim clock (30 business min): OK < 15, HALF 15-23, ESCALATION 24-29, OVERDUE from 30', () => {
    const a = anchors();
    expect(levelAt(a, '2026-11-10T10:00:00-06:00')).toBe('OK');
    expect(levelAt(a, '2026-11-10T10:14:59-06:00')).toBe('OK');
    expect(levelAt(a, '2026-11-10T10:15:00-06:00')).toBe('HALF');
    expect(levelAt(a, '2026-11-10T10:23:59-06:00')).toBe('HALF');
    expect(levelAt(a, '2026-11-10T10:24:00-06:00')).toBe('ESCALATION');
    expect(levelAt(a, '2026-11-10T10:29:59-06:00')).toBe('ESCALATION');
    expect(levelAt(a, '2026-11-10T10:30:00-06:00')).toBe('OVERDUE');
    expect(levelAt(a, '2026-11-12T10:30:00-06:00')).toBe('OVERDUE');
  });

  it('counts business time across a closed period (Saturday night, Sunday, Monday)', () => {
    // 10 of the 30 minutes fall on Saturday; the clock resumes Monday 09:00.
    const a = anchors({ createdAt: at('2026-11-14T18:50:00-06:00') });
    expect(levelAt(a, '2026-11-14T18:59:00-06:00')).toBe('OK');
    // Paused all Sunday: still OK, not "overdue by wall clock".
    expect(levelAt(a, '2026-11-15T15:00:00-06:00')).toBe('OK');
    expect(levelAt(a, '2026-11-16T09:04:00-06:00')).toBe('OK');
    expect(levelAt(a, '2026-11-16T09:05:00-06:00')).toBe('HALF');
    expect(levelAt(a, '2026-11-16T09:13:00-06:00')).toBe('HALF');
    expect(levelAt(a, '2026-11-16T09:14:00-06:00')).toBe('ESCALATION');
    expect(levelAt(a, '2026-11-16T09:19:00-06:00')).toBe('ESCALATION');
    expect(levelAt(a, '2026-11-16T09:20:00-06:00')).toBe('OVERDUE');
  });

  it('agrees with the instants of the active clock the sweep uses (every boundary, +-1 ms)', () => {
    const a = anchors({ createdAt: at('2026-11-14T18:50:00-06:00') });
    const clock = activeClock(policy(), a);
    expect(clock).not.toBeNull();
    const expected: SlaLevel[] = ['HALF', 'ESCALATION', 'OVERDUE'];
    clock?.instants.forEach(({ at: instant }, i) => {
      const before = new Date(instant.getTime() - 1);
      expect(slaLevel(policy(), a, before)).toBe(
        i === 0 ? 'OK' : expected[i - 1],
      );
      expect(slaLevel(policy(), a, instant)).toBe(expected[i]);
    });
  });

  it('uses the resolve clock once claimed (120 business min from creation)', () => {
    const a = anchors({ status: 'IN_PROGRESS' });
    expect(levelAt(a, '2026-11-10T10:59:00-06:00')).toBe('OK');
    expect(levelAt(a, '2026-11-10T11:00:00-06:00')).toBe('HALF');
    expect(levelAt(a, '2026-11-10T11:35:00-06:00')).toBe('HALF');
    expect(levelAt(a, '2026-11-10T11:36:00-06:00')).toBe('ESCALATION');
    expect(levelAt(a, '2026-11-10T12:00:00-06:00')).toBe('OVERDUE');
  });

  it('a release restarts the claim clock: the level is relative to the new cycle', () => {
    const a = anchors({ lastReleasedAt: at('2026-11-10T11:00:00-06:00') });
    expect(levelAt(a, '2026-11-10T11:10:00-06:00')).toBe('OK');
    expect(levelAt(a, '2026-11-10T11:15:00-06:00')).toBe('HALF');
    expect(levelAt(a, '2026-11-10T11:30:00-06:00')).toBe('OVERDUE');
  });

  describe('overdueAt (the request was already overdue once) forces OVERDUE', () => {
    it('late claim: overdue on the claim clock, claimed after, resolve clock still early -> OVERDUE', () => {
      // Without the mark the resolve clock (120 min from 10:00) reads OK at 10:40.
      const claimedLate = anchors({ status: 'IN_PROGRESS' });
      expect(levelAt(claimedLate, '2026-11-10T10:40:00-06:00')).toBe('OK');
      expect(
        levelAt(
          { ...claimedLate, overdueAt: at('2026-11-10T10:30:00-06:00') },
          '2026-11-10T10:40:00-06:00',
        ),
      ).toBe('OVERDUE');
    });

    it('also when the active clock has no deadline (a conversation claimed late)', () => {
      const talk = anchors({
        subtype: 'TALK_TO_HUMAN',
        status: 'IN_PROGRESS',
      });
      expect(levelAt(talk, '2026-11-10T11:00:00-06:00')).toBeNull();
      expect(
        levelAt(
          { ...talk, overdueAt: at('2026-11-10T10:10:00-06:00') },
          '2026-11-10T11:00:00-06:00',
        ),
      ).toBe('OVERDUE');
    });

    it('a released request whose new claim window is early still shows OVERDUE once marked', () => {
      const a = anchors({
        lastReleasedAt: at('2026-11-10T10:35:00-06:00'),
        overdueAt: at('2026-11-10T10:30:00-06:00'),
      });
      expect(levelAt(a, '2026-11-10T10:36:00-06:00')).toBe('OVERDUE');
    });

    it('without overdueAt the active clock decides, as before', () => {
      expect(levelAt(anchors(), '2026-11-10T10:10:00-06:00')).toBe('OK');
      expect(
        levelAt(anchors({ overdueAt: null }), '2026-11-10T10:15:00-06:00'),
      ).toBe('HALF');
    });
  });

  it('is null when the active clock has no deadline', () => {
    // Conversation: claim clock only, resolves "live" (no resolve minutes).
    expect(
      levelAt(
        anchors({ subtype: 'TALK_TO_HUMAN', status: 'IN_PROGRESS' }),
        '2026-11-10T11:00:00-06:00',
      ),
    ).toBeNull();
    // A receipt has no claim clock but has the receipt close rule.
    expect(
      levelAt(
        anchors({ subtype: 'TRANSFER_RECEIPT' }),
        '2026-11-10T10:00:00-06:00',
      ),
    ).toBe('OK');
  });

  it('is null (never throws) when the calendar cannot place a deadline', () => {
    const p = policy();
    jest.spyOn(p.calendar, 'addBusinessMinutes').mockImplementation(() => {
      throw new BusinessCalendarError('No business time inside the horizon');
    });
    expect(slaLevel(p, anchors(), at('2026-11-10T10:00:00-06:00'))).toBeNull();
  });

  it('does not swallow an unexpected error', () => {
    const p = policy();
    jest.spyOn(p.calendar, 'addBusinessMinutes').mockImplementation(() => {
      throw new TypeError('boom');
    });
    expect(() =>
      slaLevel(p, anchors(), at('2026-11-10T10:00:00-06:00')),
    ).toThrow('boom');
  });
});
