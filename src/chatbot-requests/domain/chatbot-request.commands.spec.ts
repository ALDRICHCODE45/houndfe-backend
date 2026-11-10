/**
 * DOMAIN UNIT SPEC: ChatbotRequest state machine (human-intervention unit 2,
 * contract §2.2, §3.4, §3.8, §6.5, §12.6, §12.11, §12.14, R4).
 */
import {
  cancelByCustomer,
  cancelByStaff,
  claim,
  closeWrapped,
  displayStatus,
  reassign,
  release,
  resolve,
  type ChatbotRequestState,
  type CommandResult,
} from './chatbot-request.commands';

const now = new Date('2026-11-10T16:00:00Z');
const ana = { userId: 'u-ana', displayName: 'Ana' };
const juan = { userId: 'u-juan', displayName: 'Juan' };

const request = (over: Partial<ChatbotRequestState> = {}) =>
  ({
    kind: 'DECISION',
    subtype: 'RESTOCK',
    status: 'NEW',
    version: 3,
    assignee: null,
    overdueAt: null,
    liveSessionState: null,
    ...over,
  }) as ChatbotRequestState;
const taken = (over: Partial<ChatbotRequestState> = {}) =>
  request({ status: 'IN_PROGRESS', assignee: ana, ...over });

function ok(result: CommandResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result;
}
function fail(result: CommandResult) {
  if (result.ok) throw new Error('expected an error');
  return result.error;
}

// R4: the only table a staff command may touch is chatbot_requests.
const REQUEST_COLUMNS = new Set([
  'status',
  'version',
  'assigneeUserId',
  'assigneeDisplayName',
  'claimedAt',
  'resolvedAt',
  'resolvedByActorId',
  'resolvedByDisplayName',
  'cancelledAt',
  'cancelReason',
  'staffCancelReason',
  'closedAt',
  'nextSlaCheckAt',
  'resolution',
]);

describe('claim', () => {
  it('takes a NEW request, bumps the version and appends CLAIMED', () => {
    const { patch, event } = ok(
      claim(request(), { actor: ana, expectedVersion: 3, now }),
    );
    expect(patch).toEqual({
      status: 'IN_PROGRESS',
      version: 4,
      assigneeUserId: 'u-ana',
      assigneeDisplayName: 'Ana',
      claimedAt: now,
    });
    expect(event).toEqual({
      type: 'CLAIMED',
      actorKind: 'USER',
      actorId: 'u-ana',
      actorDisplayName: 'Ana',
      fromStatus: 'NEW',
      toStatus: 'IN_PROGRESS',
      version: 4,
      data: {},
    });
  });

  it('answers 409 REQUEST_CLAIMED_BY_OTHER with claimedBy before checking the version', () => {
    const error = fail(
      claim(taken({ version: 4 }), { actor: juan, expectedVersion: 3, now }),
    );
    expect(error).toEqual({
      code: 'REQUEST_CLAIMED_BY_OTHER',
      httpStatus: 409,
      current: {
        version: 4,
        status: 'IN_PROGRESS',
        claimedBy: { id: 'u-ana', displayName: 'Ana' },
      },
    });
  });

  it('answers 409 VERSION_CONFLICT with the current version and assignee', () => {
    const error = fail(
      claim(request(), { actor: ana, expectedVersion: 2, now }),
    );
    expect(error).toMatchObject({
      code: 'VERSION_CONFLICT',
      httpStatus: 409,
      current: { version: 3, status: 'NEW', claimedBy: null },
    });
  });

  it.each(['RESOLVED', 'CANCELLED'] as const)(
    'answers 409 REQUEST_CLOSED on a %s request',
    (status) => {
      const error = fail(
        claim(request({ status }), { actor: ana, expectedVersion: 3, now }),
      );
      expect(error).toMatchObject({ code: 'REQUEST_CLOSED', httpStatus: 409 });
    },
  );

  it('answers 409 VERSION_CONFLICT when a second tab re-claims your own request', () => {
    const error = fail(claim(taken(), { actor: ana, expectedVersion: 3, now }));
    expect(error).toMatchObject({
      code: 'VERSION_CONFLICT',
      httpStatus: 409,
      current: { claimedBy: { id: 'u-ana', displayName: 'Ana' } },
    });
  });
});

describe('release', () => {
  it('returns your own request to NEW and appends RELEASED', () => {
    const { patch, event } = ok(
      release(taken(), {
        actor: ana,
        expectedVersion: 3,
        actorCanReassign: false,
      }),
    );
    expect(patch).toEqual({
      status: 'NEW',
      version: 4,
      assigneeUserId: null,
      assigneeDisplayName: null,
      claimedAt: null,
    });
    expect(event).toMatchObject({
      type: 'RELEASED',
      fromStatus: 'IN_PROGRESS',
      toStatus: 'NEW',
      data: { previousAssignee: { id: 'u-ana', displayName: 'Ana' } },
    });
  });

  it('lets someone with update:ChatbotRequestAssignment release another person', () => {
    ok(
      release(taken(), {
        actor: juan,
        expectedVersion: 3,
        actorCanReassign: true,
      }),
    );
  });

  it("answers 403 NOT_ASSIGNEE for another person's request without the permission", () => {
    const error = fail(
      release(taken(), {
        actor: juan,
        expectedVersion: 3,
        actorCanReassign: false,
      }),
    );
    expect(error).toMatchObject({ code: 'NOT_ASSIGNEE', httpStatus: 403 });
  });

  it('answers 403 NOT_ASSIGNEE before checking the version', () => {
    const error = fail(
      release(taken({ version: 5 }), {
        actor: juan,
        expectedVersion: 3,
        actorCanReassign: false,
      }),
    );
    expect(error.code).toBe('NOT_ASSIGNEE');
  });

  it('answers VERSION_CONFLICT when someone else already released it', () => {
    const error = fail(
      release(request({ version: 4 }), {
        actor: ana,
        expectedVersion: 3,
        actorCanReassign: false,
      }),
    );
    expect(error.code).toBe('VERSION_CONFLICT');
  });

  it('rejects releasing a NEW request and a live conversation (return-to-bot is unit 11)', () => {
    const args = { actor: ana, expectedVersion: 3, actorCanReassign: true };
    expect(fail(release(request(), args)).code).toBe('ACTION_NOT_ALLOWED');
    const live = taken({
      kind: 'CONVERSATION',
      subtype: 'TALK_TO_HUMAN',
      liveSessionState: 'ACTIVE',
    });
    expect(fail(release(live, args)).code).toBe('ACTION_NOT_ALLOWED');
  });
});

describe('reassign', () => {
  it('moves the request to another person and records from/to', () => {
    const { patch, event } = ok(
      reassign(taken(), {
        actor: juan,
        expectedVersion: 3,
        toUser: juan,
        note: 'turno',
        now,
      }),
    );
    expect(patch).toEqual({
      version: 4,
      assigneeUserId: 'u-juan',
      assigneeDisplayName: 'Juan',
      claimedAt: now,
    });
    expect(event).toMatchObject({
      type: 'REASSIGNED',
      fromStatus: 'IN_PROGRESS',
      toStatus: 'IN_PROGRESS',
      data: {
        fromUser: { id: 'u-ana', displayName: 'Ana' },
        toUser: { id: 'u-juan', displayName: 'Juan' },
        note: 'turno',
      },
    });
  });

  it('only reassigns IN_PROGRESS requests to a different person', () => {
    const args = { actor: juan, expectedVersion: 3, toUser: juan, now };
    expect(fail(reassign(request(), args)).code).toBe('ACTION_NOT_ALLOWED');
    expect(fail(reassign(taken({ assignee: juan }), args)).code).toBe(
      'ACTION_NOT_ALLOWED',
    );
    expect(fail(reassign(taken({ status: 'RESOLVED' }), args)).code).toBe(
      'REQUEST_CLOSED',
    );
  });
});

describe('R4: claim, release and reassign only write chatbot_requests columns', () => {
  it.each([
    claim(request(), { actor: ana, expectedVersion: 3, now }),
    release(taken(), {
      actor: ana,
      expectedVersion: 3,
      actorCanReassign: false,
    }),
    reassign(taken(), { actor: juan, expectedVersion: 3, toUser: juan, now }),
  ])('patch %#', (result) => {
    const { patch } = ok(result);
    expect(Object.keys(patch).every((key) => REQUEST_COLUMNS.has(key))).toBe(
      true,
    );
  });
});

describe('resolve', () => {
  const action = 'PROVIDE_RESTOCK_ESTIMATE';

  it('resolves a NEW decision with an implicit claim (§2.2)', () => {
    const { patch, event } = ok(
      resolve(request(), { actor: ana, expectedVersion: 3, action, now }),
    );
    expect(patch).toEqual({
      status: 'RESOLVED',
      version: 4,
      assigneeUserId: 'u-ana',
      assigneeDisplayName: 'Ana',
      claimedAt: now,
      resolvedAt: now,
      resolvedByActorId: 'u-ana',
      resolvedByDisplayName: 'Ana',
      closedAt: now,
      nextSlaCheckAt: null,
    });
    expect(event).toMatchObject({
      type: 'RESOLVED',
      fromStatus: 'NEW',
      toStatus: 'RESOLVED',
      data: { action },
    });
  });

  it('keeps the claim of the assignee', () => {
    const { patch } = ok(
      resolve(taken(), { actor: ana, expectedVersion: 3, action, now }),
    );
    expect(patch).not.toHaveProperty('assigneeUserId');
  });

  it('rejects non-decisions with 422 ACTION_NOT_ALLOWED (§12.6)', () => {
    const clarification = request({
      kind: 'CLARIFICATION',
      subtype: 'UNKNOWN_QUESTION',
    });
    const error = fail(
      resolve(clarification, { actor: ana, expectedVersion: 3, action, now }),
    );
    expect(error).toMatchObject({
      code: 'ACTION_NOT_ALLOWED',
      httpStatus: 422,
    });
  });

  it('answers REQUEST_CLAIMED_BY_OTHER, VERSION_CONFLICT and REQUEST_CLOSED', () => {
    const args = { actor: juan, expectedVersion: 3, action, now };
    expect(fail(resolve(taken(), args)).code).toBe('REQUEST_CLAIMED_BY_OTHER');
    expect(fail(resolve(request({ version: 5 }), args)).code).toBe(
      'VERSION_CONFLICT',
    );
    expect(fail(resolve(request({ status: 'CANCELLED' }), args)).code).toBe(
      'REQUEST_CLOSED',
    );
  });
});

describe('resolve with a resolution (unit 3)', () => {
  it('stores the chosen option on the request without touching the event data', () => {
    const resolution = { action: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 7 };
    const { patch, event } = ok(
      resolve(request(), {
        actor: ana,
        expectedVersion: 3,
        action: resolution.action,
        resolution,
        now,
      }),
    );
    expect(patch.resolution).toEqual(resolution);
    expect(event.data).toEqual({ action: 'PROVIDE_RESTOCK_ESTIMATE' });
  });
});

describe('closeWrapped (legacy routes and zone siblings, §2.4, R9)', () => {
  const cmd = {
    actor: ana,
    action: 'SIBLING_RESOLVED',
    resolution: { action: 'SIBLING_RESOLVED', viaRequestId: 'r-1' },
    data: { viaRequestId: 'r-1' },
    now,
  };

  it('closes a NEW request with an implicit claim and no version check', () => {
    const { patch, event } = ok(closeWrapped(request({ version: 9 }), cmd));
    expect(patch).toMatchObject({
      status: 'RESOLVED',
      version: 10,
      assigneeUserId: 'u-ana',
      claimedAt: now,
      resolvedByActorId: 'u-ana',
      resolution: cmd.resolution,
    });
    expect(event).toMatchObject({
      type: 'RESOLVED',
      fromStatus: 'NEW',
      toStatus: 'RESOLVED',
      version: 10,
      data: { action: 'SIBLING_RESOLVED', viaRequestId: 'r-1' },
    });
  });

  it('closes a request held by someone else and keeps that assignee', () => {
    const { patch } = ok(closeWrapped(taken({ assignee: juan }), cmd));
    expect(patch.status).toBe('RESOLVED');
    expect(patch).not.toHaveProperty('assigneeUserId');
  });

  it('refuses a request that is already closed', () => {
    expect(fail(closeWrapped(request({ status: 'RESOLVED' }), cmd)).code).toBe(
      'REQUEST_CLOSED',
    );
    expect(fail(closeWrapped(request({ status: 'CANCELLED' }), cmd)).code).toBe(
      'REQUEST_CLOSED',
    );
  });
});

describe('cancelByStaff (§12.11, §12.14)', () => {
  const clarification = request({
    kind: 'CLARIFICATION',
    subtype: 'UNKNOWN_QUESTION',
  });
  const conversation = (
    liveSessionState: ChatbotRequestState['liveSessionState'],
  ) =>
    request({ kind: 'CONVERSATION', subtype: 'COMPLAINT', liveSessionState });

  it('cancels a clarification with the staff reason and audit data', () => {
    const { patch, event } = ok(
      cancelByStaff(clarification, {
        actor: ana,
        actorCanReassign: false,
        expectedVersion: 3,
        reason: 'NOT_ACTIONABLE',
        customerNote: 'Lo vemos en tienda',
        now,
      }),
    );
    expect(patch).toEqual({
      status: 'CANCELLED',
      version: 4,
      cancelledAt: now,
      cancelReason: 'STAFF',
      staffCancelReason: 'NOT_ACTIONABLE',
      closedAt: now,
      nextSlaCheckAt: null,
    });
    expect(event).toMatchObject({
      type: 'CANCELLED',
      toStatus: 'CANCELLED',
      data: { reason: 'NOT_ACTIONABLE', customerNote: 'Lo vemos en tienda' },
    });
  });

  it.each([null, 'WAITING'] as const)(
    'cancels a conversation whose session is %s',
    (state) => {
      ok(
        cancelByStaff(conversation(state), {
          actor: ana,
          actorCanReassign: false,
          expectedVersion: 3,
          reason: 'DUPLICATE',
          now,
        }),
      );
    },
  );

  it.each(['STARTING', 'ACTIVE', 'ENDING'] as const)(
    'answers 409 CANCEL_NOT_ALLOWED once the session is %s',
    (state) => {
      const error = fail(
        cancelByStaff(conversation(state), {
          actor: ana,
          actorCanReassign: false,
          expectedVersion: 3,
          reason: 'DUPLICATE',
          now,
        }),
      );
      expect(error).toMatchObject({
        code: 'CANCEL_NOT_ALLOWED',
        httpStatus: 409,
      });
    },
  );

  it('answers 422 CANCEL_NOT_ALLOWED for a wrapped decision', () => {
    const error = fail(
      cancelByStaff(request(), {
        actor: ana,
        actorCanReassign: false,
        expectedVersion: 3,
        reason: 'DUPLICATE',
        now,
      }),
    );
    expect(error).toMatchObject({
      code: 'CANCEL_NOT_ALLOWED',
      httpStatus: 422,
    });
  });

  it.each(['ENDED', 'CANCELLED'] as const)(
    'answers 422 CANCEL_NOT_ALLOWED once the session is %s',
    (state) => {
      const error = fail(
        cancelByStaff(conversation(state), {
          actor: ana,
          actorCanReassign: false,
          expectedVersion: 3,
          reason: 'DUPLICATE',
          now,
        }),
      );
      expect(error).toMatchObject({
        code: 'CANCEL_NOT_ALLOWED',
        httpStatus: 422,
      });
    },
  );

  it("needs to be the claimer or hold update:ChatbotRequestAssignment to cancel another person's request (M5)", () => {
    const held = taken({ kind: 'CLARIFICATION', subtype: 'UNKNOWN_QUESTION' });
    const cmd = { expectedVersion: 3, reason: 'DUPLICATE' as const, now };
    const error = fail(
      cancelByStaff(held, { ...cmd, actor: juan, actorCanReassign: false }),
    );
    expect(error).toMatchObject({ code: 'NOT_ASSIGNEE', httpStatus: 403 });
    expect(
      fail(
        cancelByStaff(held, {
          ...cmd,
          expectedVersion: 1,
          actor: juan,
          actorCanReassign: false,
        }),
      ).code,
    ).toBe('NOT_ASSIGNEE');
    ok(cancelByStaff(held, { ...cmd, actor: juan, actorCanReassign: true }));
    ok(cancelByStaff(held, { ...cmd, actor: ana, actorCanReassign: false }));
  });

  it('requires a note with OTHER', () => {
    const error = fail(
      cancelByStaff(clarification, {
        actor: ana,
        actorCanReassign: false,
        expectedVersion: 3,
        reason: 'OTHER',
        now,
      }),
    );
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 400 });
  });

  it('checks the version', () => {
    const error = fail(
      cancelByStaff(clarification, {
        actor: ana,
        actorCanReassign: false,
        expectedVersion: 1,
        reason: 'DUPLICATE',
        now,
      }),
    );
    expect(error.code).toBe('VERSION_CONFLICT');
  });
});

describe('cancelByCustomer (§3.4)', () => {
  it('cancels without a version and records a SERVICE actor', () => {
    const { patch, event } = ok(
      cancelByCustomer(taken(), {
        credentialId: 'svc-1',
        reason: 'CUSTOMER_WITHDREW',
        now,
      }),
    );
    expect(patch).toMatchObject({
      status: 'CANCELLED',
      version: 4,
      cancelReason: 'CUSTOMER_WITHDREW',
    });
    expect(event).toMatchObject({ actorKind: 'SERVICE', actorId: 'svc-1' });
  });

  it('answers 409 ALREADY_RESOLVED so the bot delivers the answer', () => {
    const error = fail(
      cancelByCustomer(request({ status: 'RESOLVED' }), {
        credentialId: 'svc-1',
        reason: 'AUTO_RESOLVED',
        now,
      }),
    );
    expect(error).toMatchObject({ code: 'ALREADY_RESOLVED', httpStatus: 409 });
  });

  it('does not cancel a live conversation', () => {
    const live = taken({
      kind: 'CONVERSATION',
      subtype: 'TALK_TO_HUMAN',
      liveSessionState: 'ACTIVE',
    });
    const error = fail(
      cancelByCustomer(live, {
        credentialId: 'svc-1',
        reason: 'CUSTOMER_WITHDREW',
        now,
      }),
    );
    expect(error.code).toBe('CANCEL_NOT_ALLOWED');
  });
});

describe('displayStatus (§2.2)', () => {
  it('derives EXPIRED for open overdue requests only', () => {
    expect(displayStatus(request({ overdueAt: now }))).toBe('EXPIRED');
    expect(displayStatus(taken({ overdueAt: now }))).toBe('EXPIRED');
    expect(displayStatus(taken())).toBe('IN_PROGRESS');
    expect(displayStatus(request({ status: 'RESOLVED', overdueAt: now }))).toBe(
      'RESOLVED',
    );
  });
});
