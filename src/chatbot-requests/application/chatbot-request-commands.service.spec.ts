import {
  ChatbotRequestCommandError,
  ChatbotRequestCommandsService,
  type ChatbotRequestCommandStore,
  type ChatbotRequestRow,
  type ChatbotRequestView,
  type StaffCommandInput,
} from './chatbot-request-commands.service';

const ANA = { userId: 'u-ana', displayName: 'Ana' };
const LUIS = { userId: 'u-luis', displayName: 'Luis' };

function row(over: Partial<ChatbotRequestRow> = {}): ChatbotRequestRow {
  return {
    id: 'req-1',
    folio: 123,
    kind: 'CLARIFICATION',
    subtype: 'UNKNOWN_QUESTION',
    status: 'NEW',
    version: 1,
    customerKey: '525512345678',
    assigneeUserId: null,
    assigneeDisplayName: null,
    claimedAt: null,
    overdueAt: null,
    closedAt: null,
    ...over,
  };
}

/** In-memory store that records the order of every port call. */
function fakeStore(initial: ChatbotRequestRow | null) {
  const calls: string[] = [];
  const receipts = new Map<
    string,
    { commandHash: string; responseSnapshot: unknown }
  >();
  let current = initial;
  const applied: unknown[] = [];
  const store: ChatbotRequestCommandStore = {
    transaction: async (work) => {
      calls.push('begin');
      const result = await work();
      calls.push('commit');
      return result;
    },
    lockIdempotencyKey: (actorId, key) => {
      calls.push(`lockKey:${actorId}:${key}`);
      return Promise.resolve();
    },
    findReceipt: (actorId, key) => {
      calls.push('findReceipt');
      return Promise.resolve(receipts.get(`${actorId}:${key}`) ?? null);
    },
    saveReceipt: (actorId, key, commandHash, responseSnapshot) => {
      calls.push('saveReceipt');
      receipts.set(`${actorId}:${key}`, { commandHash, responseSnapshot });
      return Promise.resolve();
    },
    findActor: (userId) => {
      calls.push('findActor');
      return Promise.resolve(
        [ANA, LUIS].find((actor) => actor.userId === userId) ?? null,
      );
    },
    findAssignableUser: (userId) => {
      calls.push('findAssignableUser');
      return Promise.resolve(userId === LUIS.userId ? LUIS : null);
    },
    lockRequest: (id) => {
      calls.push('lockRequest');
      return Promise.resolve(current && current.id === id ? current : null);
    },
    apply: (locked, patch, event) => {
      calls.push('apply');
      applied.push({ patch, event });
      current = { ...locked, ...patch } as ChatbotRequestRow;
      return Promise.resolve();
    },
  };
  return { store, calls, applied, receipts };
}

function input(over: Partial<StaffCommandInput> = {}): StaffCommandInput {
  return {
    requestId: 'req-1',
    actorUserId: ANA.userId,
    actorCanReassign: false,
    idempotencyKey: '5f0b2c1e-6a43-4f7e-9c1d-2b3a4c5d6e7f',
    expectedVersion: 1,
    command: { kind: 'claim' },
    ...over,
  };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChatbotRequestCommandError) return error;
    throw error;
  }
  throw new Error('expected a ChatbotRequestCommandError');
}

describe('ChatbotRequestCommandsService', () => {
  it('claims in one transaction: key lock, receipt, row lock, apply, receipt', async () => {
    const { store, calls, applied } = fakeStore(row());
    const view = await new ChatbotRequestCommandsService(store).execute(
      input(),
    );

    expect(calls).toEqual([
      'begin',
      `lockKey:${ANA.userId}:5f0b2c1e-6a43-4f7e-9c1d-2b3a4c5d6e7f`,
      'findReceipt',
      'findActor',
      'lockRequest',
      'apply',
      'saveReceipt',
      'commit',
    ]);
    expect(applied).toEqual([
      expect.objectContaining({
        patch: expect.objectContaining({
          status: 'IN_PROGRESS',
          version: 2,
          assigneeUserId: ANA.userId,
        }) as unknown,
        event: expect.objectContaining({
          type: 'CLAIMED',
          version: 2,
        }) as unknown,
      }),
    ]);
    expect(view).toEqual<ChatbotRequestView>({
      id: 'req-1',
      folio: 'S-000123',
      kind: 'CLARIFICATION',
      subtype: 'UNKNOWN_QUESTION',
      status: 'IN_PROGRESS',
      displayStatus: 'IN_PROGRESS',
      version: 2,
      assignee: { id: ANA.userId, displayName: 'Ana' },
      claimedAt: expect.any(String) as string,
      overdueAt: null,
      closedAt: null,
    });
  });

  it('replays the stored response for the same key and body, without a write', async () => {
    const { store, calls } = fakeStore(row());
    const service = new ChatbotRequestCommandsService(store);
    const first = await service.execute(input());
    calls.length = 0;

    await expect(service.execute(input())).resolves.toEqual(first);
    expect(calls).not.toContain('lockRequest');
    expect(calls).not.toContain('apply');
  });

  it('answers 409 IDEMPOTENCY_CONFLICT for the same key with another body', async () => {
    const { store } = fakeStore(row());
    const service = new ChatbotRequestCommandsService(store);
    await service.execute(input());

    const error = await failure(
      service.execute(input({ command: { kind: 'release' } })),
    );
    expect(error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      httpStatus: 409,
    });
  });

  it('answers 404 NOT_FOUND for a missing or foreign-tenant request', async () => {
    const { store, calls } = fakeStore(null);
    const error = await failure(
      new ChatbotRequestCommandsService(store).execute(input()),
    );
    expect(error).toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    expect(calls).not.toContain('saveReceipt');
  });

  it('maps a domain rejection with the current row and stores no receipt', async () => {
    const { store, calls } = fakeStore(
      row({
        status: 'IN_PROGRESS',
        version: 4,
        assigneeUserId: LUIS.userId,
        assigneeDisplayName: 'Luis',
        claimedAt: new Date('2026-11-10T16:00:00Z'),
      }),
    );
    const error = await failure(
      new ChatbotRequestCommandsService(store).execute(
        input({ expectedVersion: 4 }),
      ),
    );
    expect(error).toMatchObject({
      code: 'REQUEST_CLAIMED_BY_OTHER',
      httpStatus: 409,
      current: {
        version: 4,
        status: 'IN_PROGRESS',
        claimedBy: { id: LUIS.userId, displayName: 'Luis' },
      },
    });
    expect(calls).not.toContain('apply');
    expect(calls).not.toContain('saveReceipt');
  });

  it('reassigns only to an assignable user (422 USER_NOT_ASSIGNABLE)', async () => {
    const claimed = row({
      status: 'IN_PROGRESS',
      version: 2,
      assigneeUserId: ANA.userId,
      assigneeDisplayName: 'Ana',
      claimedAt: new Date('2026-11-10T16:00:00Z'),
    });
    const { store } = fakeStore(claimed);
    const service = new ChatbotRequestCommandsService(store);

    const error = await failure(
      service.execute(
        input({
          expectedVersion: 2,
          actorCanReassign: true,
          command: { kind: 'reassign', toUserId: 'u-nobody' },
        }),
      ),
    );
    expect(error).toMatchObject({
      code: 'USER_NOT_ASSIGNABLE',
      httpStatus: 422,
    });

    const view = await service.execute(
      input({
        idempotencyKey: '0c7d8e9f-1a2b-4c3d-8e5f-6a7b8c9d0e1f',
        expectedVersion: 2,
        actorCanReassign: true,
        command: { kind: 'reassign', toUserId: LUIS.userId, note: 'turno' },
      }),
    );
    expect(view.assignee).toEqual({ id: LUIS.userId, displayName: 'Luis' });
    expect(view.version).toBe(3);
  });

  it('cancels with the staff reason and closes the request', async () => {
    const { store, applied } = fakeStore(row());
    const view = await new ChatbotRequestCommandsService(store).execute(
      input({
        command: {
          kind: 'cancel',
          reason: 'NOT_ACTIONABLE',
          customerNote: 'No podemos ayudar con eso.',
        },
      }),
    );
    expect(view).toMatchObject({ status: 'CANCELLED', version: 2 });
    expect(view.closedAt).toEqual(expect.any(String));
    expect(applied[0]).toMatchObject({
      patch: { cancelReason: 'STAFF', staffCancelReason: 'NOT_ACTIONABLE' },
      event: { data: { customerNote: 'No podemos ayudar con eso.' } },
    });
  });

  it('passes the reassign capability to release and cancel', async () => {
    const held = row({
      status: 'IN_PROGRESS',
      version: 2,
      assigneeUserId: LUIS.userId,
      assigneeDisplayName: 'Luis',
      claimedAt: new Date('2026-11-10T16:00:00Z'),
    });
    const denied = fakeStore(held);
    await expect(
      failure(
        new ChatbotRequestCommandsService(denied.store).execute(
          input({ expectedVersion: 2, command: { kind: 'release' } }),
        ),
      ),
    ).resolves.toMatchObject({ code: 'NOT_ASSIGNEE', httpStatus: 403 });

    const allowed = fakeStore(held);
    await expect(
      new ChatbotRequestCommandsService(allowed.store).execute(
        input({
          expectedVersion: 2,
          actorCanReassign: true,
          command: { kind: 'release' },
        }),
      ),
    ).resolves.toMatchObject({ status: 'NEW', assignee: null, version: 3 });
  });

  it('keeps resolve of a DECISION on a typed ACTION_NOT_ALLOWED until unit 3 wires it', async () => {
    const { store, calls } = fakeStore(
      row({ kind: 'DECISION', subtype: 'RESTOCK' }),
    );
    const error = await failure(
      new ChatbotRequestCommandsService(store).execute(
        input({ command: { kind: 'resolve', action: 'PROVIDE' } }),
      ),
    );
    expect(error).toMatchObject({
      code: 'ACTION_NOT_ALLOWED',
      httpStatus: 422,
      current: { version: 1, status: 'NEW', claimedBy: null },
    });
    expect(calls).not.toContain('apply');
  });

  it('answers 401 when the actor account no longer exists', async () => {
    const { store } = fakeStore(row());
    const error = await failure(
      new ChatbotRequestCommandsService(store).execute(
        input({ actorUserId: 'u-ghost' }),
      ),
    );
    expect(error).toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 });
  });
});
