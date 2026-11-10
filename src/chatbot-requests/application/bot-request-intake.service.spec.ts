import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  botEnvelopeHash,
  parseBotEnvelope,
} from '../domain/bot-request-envelope';
import { IntakeMergeSignal } from '../infrastructure/chatbot-request-intake-writes';
import { ChatbotRequestCommandError } from './chatbot-request-commands.service';
import {
  BotRequestIntakeService,
  type BotIntakeStore,
  type LegacyIntakePort,
} from './bot-request-intake.service';

const ID = '5d0c4c3e-8a43-4d52-9f6a-2c1b7e9a1f10';
const REQ = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CRED = 'cred-1';

const clarification = (over: Record<string, unknown> = {}) => ({
  sourceRequestId: ID,
  subtype: 'UNKNOWN_QUESTION',
  customer: { phoneCountryCode: '52', phone: '5512345678' },
  conversationRef: 'wa:5215512345678',
  lastCustomerMessageAt: '2026-11-09T16:02:11Z',
  summary: '¿Sirve para cachorros?',
  dedupKey: 'UNKNOWN_QUESTION:p1',
  ...over,
});
const restock = (over: Record<string, unknown> = {}) => ({
  sourceRequestId: ID,
  subtype: 'RESTOCK',
  detail: { sourceRequestId: ID, type: 'RESTOCK', productId: 'p' },
  ...over,
});

function build() {
  const store = {
    transaction: jest.fn(<T>(work: () => Promise<T>) => work()),
    lockKey: jest.fn().mockResolvedValue(undefined),
    findReceipt: jest.fn().mockResolvedValue(null),
    saveReceipt: jest.fn().mockResolvedValue(undefined),
    findCreated: jest.fn().mockResolvedValue(null),
    findWrapper: jest.fn().mockResolvedValue(null),
    createDirect: jest.fn(),
    mergeOpen: jest.fn().mockResolvedValue(null),
    lockZoneOf: jest.fn().mockResolvedValue(undefined),
    lockRequest: jest.fn(),
    applyCancel: jest.fn().mockResolvedValue(undefined),
    readResolution: jest.fn().mockResolvedValue(null),
  } satisfies Record<keyof BotIntakeStore, jest.Mock>;
  const legacy = { submit: jest.fn() } satisfies Record<
    keyof LegacyIntakePort,
    jest.Mock
  >;
  const wrapper = {
    withEnvelope: jest.fn(<T>(_e: unknown, work: () => Promise<T>) => work()),
  };
  const service = new BotRequestIntakeService(
    store as unknown as BotIntakeStore,
    legacy as unknown as LegacyIntakePort,
    wrapper as never,
  );
  const create = (body: unknown, key = ID) =>
    service.create({ credentialId: CRED, idempotencyKey: key, body });
  return { store, legacy, wrapper, service, create };
}

const created = { outcome: 'CREATED', id: REQ, folio: 7, status: 'NEW' };

describe('BotRequestIntakeService.create', () => {
  it.each([
    ['TRANSFER_RECEIPT', 'SUBTYPE_DISABLED'],
    ['DISCOUNT', 'SUBTYPE_DISABLED'],
  ])('refuses %s with 422 %s', async (subtype, code) => {
    const { create, store } = build();

    await expect(
      create(
        clarification({
          subtype,
          customer: undefined,
          dedupKey: undefined,
          conversationRef: undefined,
          lastCustomerMessageAt: undefined,
          summary: undefined,
        }),
      ),
    ).rejects.toMatchObject({ code, httpStatus: 422 });
    expect(store.transaction).not.toHaveBeenCalled();
  });

  it('refuses scheduledFor with 422 until unit 14', async () => {
    const { create } = build();

    await expect(
      create(clarification({ scheduledFor: '2026-11-10T15:00:00Z' })),
    ).rejects.toMatchObject({ code: 'SCHEDULING_DISABLED', httpStatus: 422 });
  });

  it('rejects an Idempotency-Key that differs from sourceRequestId', async () => {
    const { create } = build();

    await expect(create(clarification(), OTHER)).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it('creates a clarification: 201 CREATED with the folio', async () => {
    const { create, store } = build();
    store.createDirect.mockResolvedValue(created);

    const result = await create(clarification());

    expect(result).toEqual({
      httpStatus: 201,
      body: {
        id: REQ,
        folio: 'S-000007',
        status: 'NEW',
        outcome: 'CREATED',
        mergedIntoId: null,
        businessHours: null,
      },
    });
    expect(store.lockKey).toHaveBeenCalledWith('CREATE', ID);
    expect(store.saveReceipt).not.toHaveBeenCalled();
  });

  it('merges into the open request: 200 MERGED, stored for replay', async () => {
    const { create, store } = build();
    store.createDirect.mockResolvedValue({
      ...created,
      outcome: 'MERGED',
      id: OTHER,
    });

    const result = await create(clarification());

    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({
      id: OTHER,
      outcome: 'MERGED',
      mergedIntoId: OTHER,
    });
    expect(store.saveReceipt).toHaveBeenCalledWith(
      'CREATE',
      ID,
      botEnvelopeHash(parseBotEnvelope(clarification())),
      OTHER,
      result.body,
    );
  });

  it('replays a stored merge with the same hash and conflicts on another', async () => {
    const { create, store } = build();
    const hash = botEnvelopeHash(parseBotEnvelope(clarification()));
    const snapshot = { id: OTHER, outcome: 'MERGED', mergedIntoId: OTHER };
    store.findReceipt.mockResolvedValue({
      commandHash: hash,
      responseSnapshot: snapshot,
    });

    await expect(create(clarification())).resolves.toEqual({
      httpStatus: 200,
      body: snapshot,
    });
    await expect(
      create(clarification({ summary: 'otra' })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 });
    expect(store.createDirect).not.toHaveBeenCalled();
  });

  it('replays a created request as 200 REPLAYED, conflicting on another hash', async () => {
    const { create, store } = build();
    const hash = botEnvelopeHash(parseBotEnvelope(clarification()));
    store.findCreated.mockResolvedValue({
      id: REQ,
      folio: 7,
      canonicalRequestHash: hash,
    });

    await expect(create(clarification())).resolves.toMatchObject({
      httpStatus: 200,
      body: { id: REQ, outcome: 'REPLAYED', status: 'NEW' },
    });
    await expect(
      create(clarification({ summary: 'otra' })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('retries a direct create that lost the dedup race', async () => {
    const { create, store } = build();
    store.createDirect
      .mockRejectedValueOnce(new IntakeMergeSignal())
      .mockResolvedValueOnce({ ...created, outcome: 'MERGED', id: OTHER });

    await expect(create(clarification())).resolves.toMatchObject({
      body: { outcome: 'MERGED' },
    });
    expect(store.createDirect).toHaveBeenCalledTimes(2);
  });

  it('gives up with 409 after repeated races', async () => {
    const { create, store } = build();
    store.createDirect.mockRejectedValue(new IntakeMergeSignal());

    await expect(create(clarification())).rejects.toMatchObject({
      httpStatus: 409,
    });
    expect(store.createDirect).toHaveBeenCalledTimes(3);
  });

  describe('wrapped subtypes', () => {
    it('delegates to the legacy intake in envelope mode and returns its projection', async () => {
      const { create, legacy, wrapper, store } = build();
      legacy.submit.mockResolvedValue({
        status: 'created',
        wrappedId: 'hd-1',
        projection: { id: 'hd-1', status: 'PENDING' },
      });
      store.findWrapper.mockResolvedValue({
        id: REQ,
        folio: 9,
        canonicalRequestHash: null,
      });

      const result = await create(restock());

      expect(wrapper.withEnvelope).toHaveBeenCalledTimes(1);
      expect(legacy.submit).toHaveBeenCalledWith(
        'RESTOCK',
        restock().detail,
        CRED,
      );
      expect(store.findWrapper).toHaveBeenCalledWith('RESTOCK', 'hd-1');
      expect(result).toEqual({
        httpStatus: 201,
        body: {
          id: REQ,
          folio: 'S-000009',
          status: 'NEW',
          outcome: 'CREATED',
          mergedIntoId: null,
          businessHours: null,
          legacy: { id: 'hd-1', status: 'PENDING' },
        },
      });
    });

    it('requires the detail to repeat the sourceRequestId and the subtype', async () => {
      const { create, legacy } = build();

      await expect(
        create(
          restock({ detail: { sourceRequestId: OTHER, type: 'RESTOCK' } }),
        ),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
      await expect(
        create(
          restock({ detail: { sourceRequestId: ID, type: 'EXPIRATION' } }),
        ),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(legacy.submit).not.toHaveBeenCalled();
    });

    it('requires a zone envelope customer to match the detail phone', async () => {
      const { create, legacy } = build();
      const zone = (phone: string) => ({
        sourceRequestId: ID,
        subtype: 'DELIVERY_ZONE',
        customer: { phoneCountryCode: '52', phone: '5512345678' },
        detail: {
          sourceRequestId: ID,
          type: 'DELIVERY_ZONE',
          phoneCountryCode: '52',
          phone,
        },
      });

      await expect(create(zone('5599999999'))).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );
      expect(legacy.submit).not.toHaveBeenCalled();
    });

    it('answers a legacy replay as 200 REPLAYED and conflicts when the envelope differs', async () => {
      const { create, legacy, store } = build();
      legacy.submit.mockResolvedValue({
        status: 'replayed',
        wrappedId: 'hd-1',
        projection: {},
      });
      const hash = botEnvelopeHash(parseBotEnvelope(restock()));
      store.findWrapper.mockResolvedValue({
        id: REQ,
        folio: 9,
        canonicalRequestHash: hash,
      });

      await expect(create(restock())).resolves.toMatchObject({
        httpStatus: 200,
        body: { outcome: 'REPLAYED' },
      });

      store.findWrapper.mockResolvedValue({
        id: REQ,
        folio: 9,
        canonicalRequestHash: 'other',
      });
      await expect(create(restock())).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
    });

    it('has no request for a zone requester resolved by an existing zone', async () => {
      const { create, legacy } = build();
      legacy.submit.mockResolvedValue({
        status: 'created',
        wrappedId: 'z-1',
        projection: { id: 'z-1' },
      });

      const result = await create(restock());

      expect(result.body).toMatchObject({
        id: null,
        folio: null,
        status: 'RESOLVED',
        outcome: 'CREATED',
      });
    });

    it('merges after the hook signals, without a second legacy call', async () => {
      const { create, legacy, store } = build();
      legacy.submit.mockRejectedValue(new IntakeMergeSignal());
      store.mergeOpen.mockResolvedValue({
        outcome: 'MERGED',
        id: OTHER,
        folio: 3,
        status: 'IN_PROGRESS',
      });

      const result = await create(
        restock({
          customer: { phoneCountryCode: '52', phone: '5512345678' },
          dedupKey: 'RESTOCK:variant:1',
        }),
      );

      expect(result.body).toMatchObject({
        id: OTHER,
        status: 'IN_PROGRESS',
        outcome: 'MERGED',
        mergedIntoId: OTHER,
      });
      expect(legacy.submit).toHaveBeenCalledTimes(1);
      expect(store.saveReceipt).toHaveBeenCalledTimes(1);
    });

    it('delegates again when the open request closed before the merge', async () => {
      const { create, legacy, store } = build();
      legacy.submit
        .mockRejectedValueOnce(new IntakeMergeSignal())
        .mockResolvedValueOnce({
          status: 'created',
          wrappedId: 'hd-2',
          projection: {},
        });
      store.mergeOpen.mockResolvedValue(null);
      store.findWrapper.mockResolvedValue({
        id: REQ,
        folio: 4,
        canonicalRequestHash: null,
      });

      const result = await create(
        restock({ customer: { phoneCountryCode: '52', phone: '5512345678' } }),
      );

      expect(result.body).toMatchObject({ outcome: 'CREATED' });
      expect(legacy.submit).toHaveBeenCalledTimes(2);
    });

    it('translates a hook limit error untouched', async () => {
      const { create, legacy } = build();
      legacy.submit.mockRejectedValue(
        new ChatbotRequestCommandError('CUSTOMER_OPEN_LIMIT', 409, undefined, {
          limit: 20,
          open: 20,
        }),
      );

      await expect(create(restock())).rejects.toMatchObject({
        code: 'CUSTOMER_OPEN_LIMIT',
        extra: { limit: 20, open: 20 },
      });
    });
  });
});

describe('BotRequestIntakeService.cancel', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: REQ,
    folio: 7,
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
    humanDecisionId: null,
    deliveryZoneRequestId: null,
    receiptEvidenceId: null,
    ...over,
  });
  const cancel = (s: BotRequestIntakeService, key = OTHER) =>
    s.cancel({
      credentialId: CRED,
      idempotencyKey: key,
      requestId: REQ,
      body: { reason: 'CUSTOMER_WITHDREW', triggerWaMessageId: 'wamid.1' },
    });

  it('cancels an open request, taking the zone lock before the row', async () => {
    const { service, store } = build();
    store.lockRequest.mockResolvedValue(row());

    const result = await cancel(service);

    expect(result).toMatchObject({
      id: REQ,
      status: 'CANCELLED',
      reason: 'CUSTOMER_WITHDREW',
    });
    const order = [store.lockZoneOf, store.lockRequest, store.applyCancel].map(
      (fn) => fn.mock.invocationCallOrder[0],
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(store.applyCancel).toHaveBeenCalledWith(
      expect.objectContaining({ id: REQ }),
      expect.objectContaining({
        status: 'CANCELLED',
        cancelReason: 'CUSTOMER_WITHDREW',
      }),
      expect.objectContaining({
        data: { reason: 'CUSTOMER_WITHDREW', triggerWaMessageId: 'wamid.1' },
      }),
    );
    expect(store.saveReceipt).toHaveBeenCalledWith(
      'CANCEL',
      OTHER,
      expect.any(String),
      REQ,
      result,
    );
  });

  it('answers 404 for a missing or foreign id', async () => {
    const { service, store } = build();
    store.lockRequest.mockResolvedValue(null);

    await expect(cancel(service)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('answers 409 ALREADY_RESOLVED with the answer', async () => {
    const { service, store } = build();
    store.lockRequest.mockResolvedValue(row({ status: 'RESOLVED' }));
    store.readResolution.mockResolvedValue({ action: 'REPLY', text: 'Sí' });

    await expect(cancel(service)).rejects.toMatchObject({
      code: 'ALREADY_RESOLVED',
      httpStatus: 409,
      extra: { resolution: { action: 'REPLY', text: 'Sí' } },
    });
    expect(store.saveReceipt).not.toHaveBeenCalled();
  });

  it('replays a stored cancel and conflicts on another body', async () => {
    const { service, store } = build();
    store.findReceipt.mockResolvedValue({
      commandHash: 'x',
      responseSnapshot: { id: REQ },
    });

    await expect(cancel(service)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });

    const first = build();
    first.store.lockRequest.mockResolvedValue(row());
    let hash = '';
    first.store.saveReceipt.mockImplementation(
      (_k: string, _i: string, h: string) => {
        hash = h;
        return Promise.resolve();
      },
    );
    await cancel(first.service);
    const replay = build();
    replay.store.findReceipt.mockResolvedValue({
      commandHash: hash,
      responseSnapshot: { id: REQ, status: 'CANCELLED' },
    });

    await expect(cancel(replay.service)).resolves.toEqual({
      id: REQ,
      status: 'CANCELLED',
    });
    expect(replay.store.lockRequest).not.toHaveBeenCalled();
  });

  it('validates the body', async () => {
    const { service } = build();

    await expect(
      service.cancel({
        credentialId: CRED,
        idempotencyKey: OTHER,
        requestId: REQ,
        body: { reason: 'STAFF', triggerWaMessageId: 'w' },
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(
      service.cancel({
        credentialId: CRED,
        idempotencyKey: 'nope',
        requestId: REQ,
        body: { reason: 'AUTO_RESOLVED', triggerWaMessageId: 'w' },
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
