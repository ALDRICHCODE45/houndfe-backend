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
