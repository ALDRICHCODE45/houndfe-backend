/**
 * DOMAIN UNIT SPEC: the staff `reply` command on a clarification (human-
 * intervention unit 10; contract §2.2, §3.8, §6.2, §12.6, §12.12).
 *
 * §2.2: `IN_PROGRESS --> RESOLVED: resolve / reply / finish`. §3.10 gives the
 * route `update:ChatbotRequest (asignado)` and `403 NOT_ASSIGNEE`; owner
 * decision S13: a NEW request is claimed implicitly by the replier. §6.2: the
 * audit holds the message id, never the text; the text lives in `resolution`
 * (§3.6: it is kept after the 12-month conversation purge).
 */
import {
  reply,
  type ChatbotRequestState,
  type CommandResult,
} from './chatbot-request.commands';

const now = new Date('2026-11-12T16:00:00Z');
const ana = { userId: 'u-ana', displayName: 'Ana' };
const juan = { userId: 'u-juan', displayName: 'Juan' };
const REPLY_ID = '7d1f0c52-3a8e-4b6f-9c21-5e4d3c2b1a09';
const TEXT = 'Sí, es apto desde las 8 semanas.';

const question = (over: Partial<ChatbotRequestState> = {}) =>
  ({
    kind: 'CLARIFICATION',
    subtype: 'UNKNOWN_QUESTION',
    status: 'IN_PROGRESS',
    version: 3,
    assignee: ana,
    overdueAt: null,
    liveSessionState: null,
    ...over,
  }) as ChatbotRequestState;

const run = (
  state: ChatbotRequestState,
  over: Partial<Parameters<typeof reply>[1]> = {},
) =>
  reply(state, {
    actor: ana,
    expectedVersion: 3,
    replyId: REPLY_ID,
    text: TEXT,
    now,
    ...over,
  });

function ok(result: CommandResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result;
}
function fail(result: CommandResult) {
  if (result.ok) throw new Error('expected an error');
  return result.error;
}

describe('reply (§2.2, §3.8)', () => {
  it('resolves the assignee’s clarification: RESOLVED, version + 1, the text in resolution', () => {
    const { patch, event } = ok(run(question()));
    expect(patch).toEqual({
      status: 'RESOLVED',
      version: 4,
      resolvedAt: now,
      resolvedByActorId: 'u-ana',
      resolvedByDisplayName: 'Ana',
      closedAt: now,
      nextSlaCheckAt: null,
      resolution: { action: 'REPLY', replyId: REPLY_ID, text: TEXT },
    });
    expect(event).toEqual({
      type: 'REPLIED',
      actorKind: 'USER',
      actorId: 'u-ana',
      actorDisplayName: 'Ana',
      fromStatus: 'IN_PROGRESS',
      toStatus: 'RESOLVED',
      version: 4,
      data: { messageId: REPLY_ID },
    });
  });

  it('keeps the text out of the audit event (§6.2: the message id, not the text)', () => {
    const { event } = ok(run(question()));
    expect(JSON.stringify(event)).not.toContain('apto');
  });

  it('only writes chatbot_requests columns (R4)', () => {
    const { patch } = ok(run(question()));
    expect(Object.keys(patch).sort()).toEqual(
      [
        'closedAt',
        'nextSlaCheckAt',
        'resolution',
        'resolvedAt',
        'resolvedByActorId',
        'resolvedByDisplayName',
        'status',
        'version',
      ].sort(),
    );
  });

  describe('who may reply (§3.10, S13)', () => {
    it('replying to a NEW request claims it for the replier and resolves it in one step (S13, like resolve)', () => {
      const { patch, event } = ok(
        run(question({ status: 'NEW', assignee: null }), { actor: juan }),
      );
      expect(patch).toEqual({
        status: 'RESOLVED',
        version: 4,
        assigneeUserId: 'u-juan',
        assigneeDisplayName: 'Juan',
        claimedAt: now,
        resolvedAt: now,
        resolvedByActorId: 'u-juan',
        resolvedByDisplayName: 'Juan',
        closedAt: now,
        nextSlaCheckAt: null,
        resolution: { action: 'REPLY', replyId: REPLY_ID, text: TEXT },
      });
      // One event, like resolve's implicit claim: no separate CLAIMED.
      expect(event).toMatchObject({
        type: 'REPLIED',
        actorId: 'u-juan',
        fromStatus: 'NEW',
        toStatus: 'RESOLVED',
        version: 4,
        data: { messageId: REPLY_ID },
      });
    });

    it('a NEW request checks the version too', () => {
      expect(
        fail(
          run(question({ status: 'NEW', assignee: null, version: 5 }), {
            expectedVersion: 3,
          }),
        ),
      ).toMatchObject({ code: 'VERSION_CONFLICT', httpStatus: 409 });
    });

    it('refuses a request held by someone else (403 NOT_ASSIGNEE, current names the holder)', () => {
      expect(fail(run(question(), { actor: juan }))).toMatchObject({
        code: 'NOT_ASSIGNEE',
        httpStatus: 403,
        current: { claimedBy: { id: 'u-ana', displayName: 'Ana' } },
      });
    });
  });

  describe('which requests can be replied to', () => {
    it.each(['DECISION', 'CONVERSATION'] as const)(
      'refuses kind %s (422 ACTION_NOT_ALLOWED): decisions resolve, conversations finish (§12.6)',
      (kind) => {
        expect(fail(run(question({ kind })))).toMatchObject({
          code: 'ACTION_NOT_ALLOWED',
          httpStatus: 422,
        });
      },
    );

    it.each(['RESOLVED', 'CANCELLED'] as const)(
      'answers 409 REQUEST_CLOSED on a %s request',
      (status) => {
        expect(fail(run(question({ status })))).toMatchObject({
          code: 'REQUEST_CLOSED',
          httpStatus: 409,
        });
      },
    );
  });

  describe('check order: closed, kind, assignee, version', () => {
    it('a closed decision is REQUEST_CLOSED', () => {
      expect(
        fail(run(question({ kind: 'DECISION', status: 'RESOLVED' }))).code,
      ).toBe('REQUEST_CLOSED');
    });
    it('a decision held by someone else is ACTION_NOT_ALLOWED, not NOT_ASSIGNEE', () => {
      expect(
        fail(run(question({ kind: 'DECISION' }), { actor: juan })).code,
      ).toBe('ACTION_NOT_ALLOWED');
    });
    it('someone else’s stale view is NOT_ASSIGNEE before VERSION_CONFLICT', () => {
      expect(
        fail(run(question({ version: 5 }), { actor: juan, expectedVersion: 3 }))
          .code,
      ).toBe('NOT_ASSIGNEE');
    });
    it('the assignee with a stale version gets 409 VERSION_CONFLICT with the current row', () => {
      expect(
        fail(run(question({ version: 5 }), { expectedVersion: 3 })),
      ).toMatchObject({
        code: 'VERSION_CONFLICT',
        httpStatus: 409,
        current: { version: 5, status: 'IN_PROGRESS' },
      });
    });
  });
});
