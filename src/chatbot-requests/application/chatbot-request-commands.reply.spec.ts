/**
 * APPLICATION SPEC: the staff `reply` command (human-intervention unit 10;
 * contract §3.8, §6.5, §12.12). One transaction: receipt, row lock, the pure
 * state machine, the CAS patch + REPLIED event, the `request.answered` feed
 * item (rule 6: after the state change, before the group refresh), the receipt.
 */
import {
  ChatbotRequestCommandError,
  ChatbotRequestCommandsService,
  type ChatbotRequestCommandStore,
  type ChatbotRequestRow,
  type StaffCommandInput,
} from './chatbot-request-commands.service';
import type {
  ChatbotRequestEventDraft,
  ChatbotRequestPatch,
} from '../domain/chatbot-request.commands';

const ANA = { userId: 'u-ana', displayName: 'Ana' };
const LUIS = { userId: 'u-luis', displayName: 'Luis' };
const KEY = '5f0b2c1e-6a43-4f7e-9c1d-2b3a4c5d6e7f';
const TEXT = 'Sí, es apto desde las 8 semanas.';

const row = (over: Partial<ChatbotRequestRow> = {}): ChatbotRequestRow => ({
  id: 'req-1',
  folio: 123,
  kind: 'CLARIFICATION',
  subtype: 'UNKNOWN_QUESTION',
  status: 'IN_PROGRESS',
  version: 2,
  customerKey: '525512345678',
  conversationRef: 'wa:525512345678',
  assigneeUserId: ANA.userId,
  assigneeDisplayName: ANA.displayName,
  claimedAt: new Date('2026-11-12T15:00:00Z'),
  overdueAt: null,
  closedAt: null,
  humanDecisionId: null,
  deliveryZoneRequestId: null,
  receiptEvidenceId: null,
  ...over,
});

function fakeStore(initial: ChatbotRequestRow | null) {
  const calls: string[] = [];
  const applied: Array<{
    patch: ChatbotRequestPatch;
    event: ChatbotRequestEventDraft;
  }> = [];
  const answers: Array<{ id: string; replyId: string; text: string }> = [];
  const receipts = new Map<
    string,
    { commandHash: string; responseSnapshot: unknown }
  >();
  let current = initial;
  const unused = () => Promise.reject(new Error('not expected'));
  const store: ChatbotRequestCommandStore = {
    transaction: async (work) => {
      calls.push('begin');
      const result = await work();
      calls.push('commit');
      return result;
    },
    lockIdempotencyKey: () => {
      calls.push('lockKey');
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
    findActor: (userId) =>
      Promise.resolve([ANA, LUIS].find((a) => a.userId === userId) ?? null),
    findAssignableUser: unused,
    lockRequest: (id) => {
      calls.push('lockRequest');
      return Promise.resolve(current && current.id === id ? current : null);
    },
    apply: unused,
    applyPatch: (locked, patch, event) => {
      calls.push('applyPatch');
      applied.push({ patch, event });
      current = { ...locked, ...patch } as ChatbotRequestRow;
      return Promise.resolve();
    },
    refreshGroups: (keys) => {
      calls.push(`refreshGroups:${keys.join(',')}`);
      return Promise.resolve();
    },
    enqueueAnswered: unused,
    enqueueClarificationAnswer: (id, replyId, text) => {
      calls.push('enqueueClarificationAnswer');
      answers.push({ id, replyId, text });
      return Promise.resolve();
    },
    enqueueCancelled: unused,
    lockZoneOf: unused,
    lockZoneSet: unused,
    readZoneImpact: unused,
    startLiveSession: unused,
    reassignLiveSession: unused,
    beginLiveSessionEnding: unused,
    emitSessionEvent: unused,
  };
  return { store, calls, applied, answers };
}

const input = (over: Partial<StaffCommandInput> = {}): StaffCommandInput => ({
  requestId: 'req-1',
  actorUserId: ANA.userId,
  actorCanReassign: false,
  idempotencyKey: KEY,
  expectedVersion: 2,
  command: { kind: 'reply', text: TEXT },
  ...over,
});

const service = (store: ChatbotRequestCommandStore) =>
  new ChatbotRequestCommandsService(store, {
    resolve: () => Promise.reject(new Error('resolver not expected')),
  });

describe('ChatbotRequestCommandsService: reply', () => {
  it('resolves the request, appends REPLIED and feeds the bot once, in lock order', async () => {
    const { store, calls, applied, answers } = fakeStore(row());
    const view = await service(store).execute(input());

    expect(view).toMatchObject({
      id: 'req-1',
      status: 'RESOLVED',
      displayStatus: 'RESOLVED',
      version: 3,
    });
    expect(calls).toEqual([
      'begin',
      'lockKey',
      'findReceipt',
      'lockRequest',
      'applyPatch',
      'enqueueClarificationAnswer',
      'refreshGroups:525512345678',
      'saveReceipt',
      'commit',
    ]);
    expect(applied).toHaveLength(1);
    const { replyId } = applied[0].patch.resolution as { replyId: string };
    expect(replyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(applied[0].event).toMatchObject({
      type: 'REPLIED',
      data: { messageId: replyId },
    });
    expect(answers).toEqual([{ id: 'req-1', replyId, text: TEXT }]);
  });

  it('replying to a NEW request claims it for the replier in the same write (S13): one patch, one answer', async () => {
    const { store, calls, applied, answers } = fakeStore(
      row({
        status: 'NEW',
        assigneeUserId: null,
        assigneeDisplayName: null,
        claimedAt: null,
      }),
    );
    const view = await service(store).execute(
      input({ actorUserId: LUIS.userId, expectedVersion: 2 }),
    );
    expect(view).toMatchObject({
      status: 'RESOLVED',
      version: 3,
      assignee: { id: LUIS.userId, displayName: 'Luis' },
    });
    expect(applied).toHaveLength(1);
    expect(applied[0].patch).toMatchObject({
      assigneeUserId: LUIS.userId,
      resolvedByActorId: LUIS.userId,
    });
    expect(calls.filter((c) => c === 'applyPatch')).toHaveLength(1);
    expect(answers).toHaveLength(1);
  });

  it('replays the stored response for the same key and body: no second answer', async () => {
    const { store, applied, answers } = fakeStore(row());
    const svc = service(store);
    const first = await svc.execute(input());
    const second = await svc.execute(input());
    expect(second).toEqual(first);
    expect(applied).toHaveLength(1);
    expect(answers).toHaveLength(1);
  });

  it('409 IDEMPOTENCY_CONFLICT for the same key with another text', async () => {
    const { store, answers } = fakeStore(row());
    const svc = service(store);
    await svc.execute(input());
    await expect(
      svc.execute(input({ command: { kind: 'reply', text: 'Otra cosa' } })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 });
    expect(answers).toHaveLength(1);
  });

  it('a rejected reply throws, feeds nothing and stores no receipt', async () => {
    const { store, calls, answers } = fakeStore(row());
    await expect(
      service(store).execute(input({ actorUserId: LUIS.userId })),
    ).rejects.toMatchObject({ code: 'NOT_ASSIGNEE', httpStatus: 403 });
    expect(answers).toEqual([]);
    expect(calls).not.toContain('saveReceipt');
    expect(calls).not.toContain('applyPatch');
  });

  it('a second reply with another key finds the request closed (once per request)', async () => {
    const { store, answers } = fakeStore(row());
    const svc = service(store);
    await svc.execute(input());
    await expect(
      svc.execute(
        input({
          idempotencyKey: '6a1b2c3d-1111-4222-8333-444455556666',
          expectedVersion: 3,
        }),
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_CLOSED', httpStatus: 409 });
    expect(answers).toHaveLength(1);
  });

  it('404 for an unknown request', async () => {
    const { store } = fakeStore(null);
    await expect(service(store).execute(input())).rejects.toBeInstanceOf(
      ChatbotRequestCommandError,
    );
    await expect(service(store).execute(input())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
  });
});
