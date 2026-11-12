/**
 * S11 / T7g: the one rule behind the `windowClosingSoon` inbox filter, the
 * `/counts` number and the per-row boolean: an OPEN request whose WhatsApp
 * window closes in `(now, now + windowWarningMinutes]`.
 */
import {
  isWindowClosingSoon,
  windowClosingSoonRange,
} from './window-closing-soon';

const MIN = 60_000;
const NOW = new Date('2026-11-12T12:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);

const row = (
  minutes: number | null,
  status: 'NEW' | 'IN_PROGRESS' | 'RESOLVED' | 'CANCELLED' = 'NEW',
) => ({
  status,
  whatsappWindowClosesAt: minutes === null ? null : at(minutes),
});

describe('windowClosingSoonRange', () => {
  it('is (now, now + minutes] as concrete instants', () => {
    expect(windowClosingSoonRange(NOW, 60)).toEqual({
      after: NOW,
      upTo: at(60),
    });
    expect(windowClosingSoonRange(NOW, 120).upTo).toEqual(at(120));
  });

  it('0 minutes is an empty range (the warning is off)', () => {
    const { after, upTo } = windowClosingSoonRange(NOW, 0);
    expect(upTo.getTime()).toBe(after.getTime());
  });
});

describe('isWindowClosingSoon', () => {
  describe.each([
    ['tenant default (120)', 120],
    ['tenant on 60', 60],
  ])('%s', (_label, warning) => {
    it('a window that already closed (-1 min) is not closing soon', () => {
      expect(isWindowClosingSoon(row(-1), NOW, warning)).toBe(false);
    });

    it('a window closing exactly now (0) counts as closed: not closing soon', () => {
      expect(isWindowClosingSoon(row(0), NOW, warning)).toBe(false);
    });

    it('one minute left (+1) is closing soon', () => {
      expect(isWindowClosingSoon(row(1), NOW, warning)).toBe(true);
    });

    it('the edge of the warning is included, one minute beyond is not', () => {
      expect(isWindowClosingSoon(row(warning - 1), NOW, warning)).toBe(true);
      expect(isWindowClosingSoon(row(warning), NOW, warning)).toBe(true);
      expect(isWindowClosingSoon(row(warning + 1), NOW, warning)).toBe(false);
    });
  });

  it('the same row flips with the tenant setting: 90 min is soon at 120, not at 60', () => {
    expect(isWindowClosingSoon(row(90), NOW, 120)).toBe(true);
    expect(isWindowClosingSoon(row(90), NOW, 60)).toBe(false);
  });

  it('one millisecond either side of the upper edge', () => {
    const edge = at(60).getTime();
    const closes = (ms: number) => ({
      status: 'NEW' as const,
      whatsappWindowClosesAt: new Date(ms),
    });
    expect(isWindowClosingSoon(closes(edge), NOW, 60)).toBe(true);
    expect(isWindowClosingSoon(closes(edge + 1), NOW, 60)).toBe(false);
    expect(isWindowClosingSoon(closes(NOW.getTime() + 1), NOW, 60)).toBe(true);
    expect(isWindowClosingSoon(closes(NOW.getTime()), NOW, 60)).toBe(false);
  });

  it('IN_PROGRESS is open like NEW', () => {
    expect(isWindowClosingSoon(row(30, 'IN_PROGRESS'), NOW, 60)).toBe(true);
  });

  it.each(['RESOLVED', 'CANCELLED'] as const)(
    'a %s request is never closing soon, even inside the range',
    (status) => {
      expect(isWindowClosingSoon(row(30, status), NOW, 120)).toBe(false);
    },
  );

  it('a request with no window is false', () => {
    expect(isWindowClosingSoon(row(null), NOW, 120)).toBe(false);
  });

  it('0 minutes turns it off for every row', () => {
    for (const minutes of [-1, 0, 1, 30]) {
      expect(isWindowClosingSoon(row(minutes), NOW, 0)).toBe(false);
    }
  });
});
