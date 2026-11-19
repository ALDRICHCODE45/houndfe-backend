import {
  SESSION_TIMING,
  decideSessionAck,
  dueSessionAction,
  messageStatusForOutcome,
  parseFinishNote,
  parseStaffMessageContent,
  parseStaffMessageText,
  staffFirstName,
  whatsappWindowClosesAt,
  type SessionRecord,
} from './live-session';

const T0 = new Date('2026-11-13T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const session = (patch: Partial<SessionRecord> = {}): SessionRecord => ({
  epoch: 3,
  state: 'STARTING',
  startedAt: T0,
  activeAt: null,
  endingAt: null,
  ...patch,
});

describe('staffFirstName', () => {
  it.each([
    ['Ana López', 'Ana'],
    ['  Ana  ', 'Ana'],
    ['Ana', 'Ana'],
  ])('%j -> %j', (input, expected) =>
    expect(staffFirstName(input)).toBe(expected),
  );
  it.each([[''], ['   '], ['ana@example.com'], ['Usuario']])(
    '%j has no usable first name',
    (input) => expect(staffFirstName(input)).toBeNull(),
  );
  it('has no name for a missing display name', () =>
    expect(staffFirstName(null)).toBeNull());
});

describe('decideSessionAck', () => {
  it('STARTED on the STARTING session of that epoch applies', () =>
    expect(decideSessionAck(session(), 3, 'STARTED')).toBe('APPLY'));
  it('STARTED again on ACTIVE is an idempotent replay', () =>
    expect(decideSessionAck(session({ state: 'ACTIVE' }), 3, 'STARTED')).toBe(
      'REPLAY',
    ));
  it('a late STARTED after the revert is STALE_EPOCH (§12.15)', () =>
    expect(decideSessionAck(session({ state: 'ENDED' }), 3, 'STARTED')).toBe(
      'STALE_EPOCH',
    ));
  it('STARTED for an old or a future epoch is STALE_EPOCH', () => {
    expect(decideSessionAck(session({ epoch: 4 }), 3, 'STARTED')).toBe(
      'STALE_EPOCH',
    );
    expect(decideSessionAck(session({ epoch: 2 }), 3, 'STARTED')).toBe(
      'STALE_EPOCH',
    );
  });
  it('ENDED on an ENDING session applies; on ENDED it replays', () => {
    expect(decideSessionAck(session({ state: 'ENDING' }), 3, 'ENDED')).toBe(
      'APPLY',
    );
    expect(decideSessionAck(session({ state: 'ENDED' }), 3, 'ENDED')).toBe(
      'REPLAY',
    );
  });
  it('the bot cannot end a STARTING or ACTIVE session (§4.1)', () => {
    expect(decideSessionAck(session(), 3, 'ENDED')).toBe('SESSION_NOT_ENDING');
    expect(decideSessionAck(session({ state: 'ACTIVE' }), 3, 'ENDED')).toBe(
      'SESSION_NOT_ENDING',
    );
  });
  it('ENDED of a past epoch whose session is long over replays', () =>
    expect(decideSessionAck(session({ epoch: 4 }), 3, 'ENDED')).toBe('REPLAY'));
  it('ENDED for an epoch above the backend is STALE_EPOCH', () =>
    expect(decideSessionAck(session({ epoch: 2 }), 3, 'ENDED')).toBe(
      'STALE_EPOCH',
    ));
});

describe('dueSessionAction (the sweep)', () => {
  it('reverts a STARTING session with no snapshot after the 120 s default, not before', () => {
    expect(dueSessionAction(session(), at(119_999), null)).toBeNull();
    expect(dueSessionAction(session(), at(120_000), null)).toBe('REVERT_START');
  });
  it('reverts a STARTING session at its own startDeadlineAt (the tenant setting snapshotted at the claim)', () => {
    const custom = session({ startDeadlineAt: at(45_000) });
    expect(dueSessionAction(custom, at(44_999), null)).toBeNull();
    expect(dueSessionAction(custom, at(45_000), null)).toBe('REVERT_START');
    const long = session({ startDeadlineAt: at(600_000) });
    expect(dueSessionAction(long, at(599_999), null)).toBeNull();
    expect(dueSessionAction(long, at(600_000), null)).toBe('REVERT_START');
  });
  it('ends an ENDING session nobody acknowledged after 10 min', () => {
    const ending = session({ state: 'ENDING', endingAt: T0 });
    expect(dueSessionAction(ending, at(599_999), null)).toBeNull();
    expect(dueSessionAction(ending, at(600_000), null)).toBe('MARK_ENDED');
  });
  it('ends an ACTIVE session after 2 h without a customer message', () => {
    const active = session({ state: 'ACTIVE', activeAt: T0 });
    expect(
      dueSessionAction(active, at(SESSION_TIMING.idleEndMs - 1), null),
    ).toBeNull();
    expect(dueSessionAction(active, at(SESSION_TIMING.idleEndMs), null)).toBe(
      'IDLE_END',
    );
  });
  it('a customer message restarts the idle clock', () => {
    const active = session({ state: 'ACTIVE', activeAt: T0 });
    const wrote = at(60 * 60_000);
    expect(
      dueSessionAction(active, at(SESSION_TIMING.idleEndMs), wrote),
    ).toBeNull();
    expect(
      dueSessionAction(
        active,
        at(60 * 60_000 + SESSION_TIMING.idleEndMs),
        wrote,
      ),
    ).toBe('IDLE_END');
  });
  it('an ENDED session is never due', () =>
    expect(
      dueSessionAction(session({ state: 'ENDED' }), at(1e9), null),
    ).toBeNull());
});

describe('whatsappWindowClosesAt', () => {
  it('is 24 h after the latest customer message of either source', () => {
    const a = new Date('2026-11-13T10:00:00.000Z');
    const b = new Date('2026-11-13T11:00:00.000Z');
    expect(whatsappWindowClosesAt(a, b)?.toISOString()).toBe(
      '2026-11-14T11:00:00.000Z',
    );
    expect(whatsappWindowClosesAt(null, a)?.toISOString()).toBe(
      '2026-11-14T10:00:00.000Z',
    );
    expect(whatsappWindowClosesAt(null, null)).toBeNull();
  });
  it('a correction from Meta (DEFERRED_WINDOW_CLOSED) caps the window', () => {
    const last = new Date('2026-11-13T10:00:00.000Z');
    const reported = new Date('2026-11-13T12:00:00.000Z');
    // The bot says it was closed at `reported`: the window closed no later.
    expect(whatsappWindowClosesAt(last, null, reported)?.toISOString()).toBe(
      reported.toISOString(),
    );
    // A customer message AFTER the report reopens it.
    const later = new Date('2026-11-13T13:00:00.000Z');
    expect(whatsappWindowClosesAt(later, null, reported)?.toISOString()).toBe(
      '2026-11-14T13:00:00.000Z',
    );
  });
  it('a verdict is not overridden by an older customer message of either source', () => {
    const chat = new Date('2026-11-13T10:00:00.000Z');
    const request = new Date('2026-11-13T11:00:00.000Z');
    const reported = new Date('2026-11-13T12:00:00.000Z');
    expect(whatsappWindowClosesAt(chat, request, reported)).toEqual(reported);
    // the request's own (newer) value reopens it
    const newer = new Date('2026-11-13T12:30:00.000Z');
    expect(whatsappWindowClosesAt(chat, newer, reported)?.toISOString()).toBe(
      '2026-11-14T12:30:00.000Z',
    );
  });
});

describe('messageStatusForOutcome', () => {
  it.each([
    ['PROVIDER_ACCEPTED', 'SENT'],
    ['DELIVERY_UNKNOWN', 'UNKNOWN'],
    ['DEFERRED_WINDOW_CLOSED', 'DEFERRED'],
    ['STALE', 'FAILED'],
  ] as const)('%s -> %s', (outcome, status) =>
    expect(messageStatusForOutcome(outcome)).toBe(status),
  );
});

describe('parseStaffMessageText', () => {
  it('keeps the text as written (line breaks included)', () =>
    expect(parseStaffMessageText('Hola\nAna ')).toBe('Hola\nAna'));
  it.each([[undefined], [''], ['   '], [5], ['x'.repeat(4097)], ['a\u0000b']])(
    '%j is rejected',
    (input) => expect(() => parseStaffMessageText(input)).toThrow(),
  );
  it('accepts exactly 4096 characters', () =>
    expect(parseStaffMessageText('x'.repeat(4096))).toHaveLength(4096));
});

describe('parseFinishNote', () => {
  it('requires a note of 1..1000 characters', () => {
    expect(parseFinishNote(' listo ')).toBe('listo');
    expect(() => parseFinishNote('')).toThrow();
    expect(() => parseFinishNote('x'.repeat(1001))).toThrow();
    expect(() => parseFinishNote(undefined)).toThrow();
  });
});

describe('parseStaffMessageContent (S15 Q5)', () => {
  const id = '2f6b1c1e-6c1d-4a0c-9d0a-0f4a5b6c7d8e';
  it('TEXT is the default and takes no media fields', () => {
    expect(parseStaffMessageContent({ text: ' hola ' })).toEqual({
      type: 'TEXT',
      text: 'hola',
    });
    expect(() =>
      parseStaffMessageContent({ type: 'TEXT', text: 'x', mediaId: id }),
    ).toThrow();
    expect(() =>
      parseStaffMessageContent({ text: 'x', caption: 'y' }),
    ).toThrow();
    expect(() => parseStaffMessageContent({})).toThrow();
  });
  it('IMAGE/DOCUMENT need a mediaId, take no text, and the caption is trimmed, printable and <= 1024', () => {
    expect(
      parseStaffMessageContent({ type: 'IMAGE', mediaId: id.toUpperCase() }),
    ).toEqual({ type: 'IMAGE', mediaId: id, caption: null });
    expect(
      parseStaffMessageContent({
        type: 'DOCUMENT',
        mediaId: id,
        caption: ' a ',
      }),
    ).toEqual({ type: 'DOCUMENT', mediaId: id, caption: 'a' });
    expect(() => parseStaffMessageContent({ type: 'IMAGE' })).toThrow();
    expect(() =>
      parseStaffMessageContent({ type: 'IMAGE', mediaId: id, text: 'x' }),
    ).toThrow();
    expect(() =>
      parseStaffMessageContent({ type: 'IMAGE', mediaId: id, caption: ' ' }),
    ).toThrow();
    expect(() =>
      parseStaffMessageContent({
        type: 'IMAGE',
        mediaId: id,
        caption: 'x'.repeat(1025),
      }),
    ).toThrow();
    expect(() =>
      parseStaffMessageContent({ type: 'AUDIO', mediaId: id }),
    ).toThrow();
  });
});
