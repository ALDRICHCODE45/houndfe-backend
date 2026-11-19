import {
  finish,
  type ChatbotRequestState,
  type StaffActor,
} from './chatbot-request.commands';

const ana: StaffActor = { userId: 'ana', displayName: 'Ana' };
const luis: StaffActor = { userId: 'luis', displayName: 'Luis' };
const NOW = new Date('2026-11-13T12:00:00.000Z');
const live = (
  patch: Partial<ChatbotRequestState> = {},
): ChatbotRequestState => ({
  kind: 'CONVERSATION',
  subtype: 'TALK_TO_HUMAN',
  status: 'IN_PROGRESS',
  version: 4,
  assignee: ana,
  overdueAt: null,
  liveSessionState: 'ACTIVE',
  ...patch,
});
const cmd = (over: object = {}) => ({
  actor: ana,
  actorCanReassign: false,
  expectedVersion: 4,
  note: 'Resuelto por teléfono',
  now: NOW,
  ...over,
});
const errorOf = (r: ReturnType<typeof finish>) =>
  r.ok ? null : `${r.error.code}/${r.error.httpStatus}`;

describe('finish (§4.8)', () => {
  it('the assignee closes an ACTIVE session: RESOLVED + FINISHED event', () => {
    const r = finish(live(), cmd());
    if (!r.ok) throw new Error('expected ok');
    expect(r.patch).toMatchObject({
      status: 'RESOLVED',
      version: 5,
      resolvedAt: NOW,
      closedAt: NOW,
      nextSlaCheckAt: null,
      resolvedByActorId: 'ana',
      resolution: { action: 'FINISH', note: 'Resuelto por teléfono' },
    });
    expect(r.event).toMatchObject({
      type: 'FINISHED',
      fromStatus: 'IN_PROGRESS',
      toStatus: 'RESOLVED',
      version: 5,
      data: { note: 'Resuelto por teléfono', forced: false },
    });
  });

  it('a reassigner may force it (forced: true)', () => {
    const r = finish(live(), cmd({ actor: luis, actorCanReassign: true }));
    if (!r.ok) throw new Error('expected ok');
    expect(r.event.data).toMatchObject({ forced: true });
  });

  it('carries the complaint classification when sent', () => {
    const r = finish(
      live({ subtype: 'COMPLAINT' }),
      cmd({ complaintOutcome: 'REFUND' }),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.event.data).toMatchObject({ complaintOutcome: 'REFUND' });
    expect(r.patch.resolution).toMatchObject({ complaintOutcome: 'REFUND' });
  });

  describe('complaint classification is mandatory (unit 12, §4.8)', () => {
    const complaint = (patch: Partial<ChatbotRequestState> = {}) =>
      live({ subtype: 'COMPLAINT', ...patch });

    it.each(['RETURN', 'REPLACEMENT', 'REFUND', 'NO_ACTION'])(
      'a COMPLAINT closes with %s and records it in the row and the event',
      (value) => {
        const r = finish(complaint(), cmd({ complaintOutcome: value }));
        if (!r.ok) throw new Error('expected ok');
        expect(r.patch.resolution).toMatchObject({ complaintOutcome: value });
        expect(r.event.data).toMatchObject({ complaintOutcome: value });
      },
    );

    it.each([undefined, null, ''])(
      'a COMPLAINT without it (%p) is refused: 422 COMPLAINT_OUTCOME_REQUIRED, nothing changes',
      (value) => {
        const r = finish(complaint(), cmd({ complaintOutcome: value }));
        expect(errorOf(r)).toBe('COMPLAINT_OUTCOME_REQUIRED/422');
        if (r.ok) throw new Error('expected a refusal');
        expect(r.error.current).toMatchObject({ version: 4 });
      },
    );

    it('the state checks answer first: a stale version, a foreign holder or a closed request win over the missing outcome', () => {
      expect(errorOf(finish(complaint({ version: 9 }), cmd()))).toBe(
        'VERSION_CONFLICT/409',
      );
      expect(errorOf(finish(complaint({ assignee: luis }), cmd()))).toBe(
        'NOT_ASSIGNEE/403',
      );
      expect(
        errorOf(finish(complaint({ liveSessionState: 'ENDING' }), cmd())),
      ).toBe('SESSION_NOT_ACTIVE/409');
      expect(errorOf(finish(complaint({ status: 'RESOLVED' }), cmd()))).toBe(
        'REQUEST_CLOSED/409',
      );
    });

    it('a forced finish of a COMPLAINT needs it too', () => {
      expect(
        errorOf(
          finish(complaint(), cmd({ actor: luis, actorCanReassign: true })),
        ),
      ).toBe('COMPLAINT_OUTCOME_REQUIRED/422');
    });

    it('a request that is not a COMPLAINT does not need it and does not keep one that was sent', () => {
      const r = finish(live(), cmd({ complaintOutcome: 'REFUND' }));
      if (!r.ok) throw new Error('expected ok');
      expect(r.patch.resolution).toEqual({
        action: 'FINISH',
        note: 'Resuelto por teléfono',
      });
      expect(r.event.data).toEqual({
        note: 'Resuelto por teléfono',
        forced: false,
      });
    });
  });

  it.each([
    ['closed request', { status: 'RESOLVED' as const }, 'REQUEST_CLOSED/409'],
    [
      'not a conversation',
      { kind: 'CLARIFICATION' as const },
      'ACTION_NOT_ALLOWED/422',
    ],
    [
      'nobody holds it',
      { status: 'NEW' as const, assignee: null },
      'ACTION_NOT_ALLOWED/422',
    ],
    ['someone else holds it', { assignee: luis }, 'NOT_ASSIGNEE/403'],
    ['stale version', { version: 9 }, 'VERSION_CONFLICT/409'],
    [
      'session still STARTING',
      { liveSessionState: 'STARTING' as const },
      'SESSION_NOT_ACTIVE/409',
    ],
    [
      'session ENDING',
      { liveSessionState: 'ENDING' as const },
      'SESSION_NOT_ACTIVE/409',
    ],
    ['no session at all', { liveSessionState: null }, 'SESSION_NOT_ACTIVE/409'],
  ])('refuses: %s', (_name, patch, expected) =>
    expect(errorOf(finish(live(patch), cmd()))).toBe(expected),
  );
});
