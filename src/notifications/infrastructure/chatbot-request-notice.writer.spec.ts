import {
  enqueueClosedNotice,
  enqueueNotice,
} from './chatbot-request-notice.writer';

const base = {
  requestId: 'req-1',
  folio: 7,
  subtype: 'RESTOCK',
  dedupKey: 'k',
};

function tx() {
  const create = jest
    .fn<
      Promise<unknown>,
      [{ data: { payload: Record<string, unknown> } & Record<string, unknown> }]
    >()
    .mockResolvedValue({});
  return { create, client: { outboxEvent: { create } } as never };
}

describe('enqueueNotice (producer, same transaction as the state change)', () => {
  it('writes one chatbot_request.notify row with no customer data', async () => {
    const { create, client } = tx();

    await expect(
      enqueueNotice(client, 'tenant-1', { ...base, type: 'REQUEST_CREATED' }),
    ).resolves.toBe(true);

    expect(create).toHaveBeenCalledTimes(1);
    const { data } = create.mock.calls[0][0];
    expect(data).toMatchObject({
      tenantId: 'tenant-1',
      aggregateType: 'ChatbotRequest',
      aggregateId: 'req-1',
      eventType: 'chatbot_request.notify',
    });
    expect(Object.keys(data.payload).sort()).toEqual(
      ['dedupKey', 'folio', 'requestId', 'subtype', 'type'].sort(),
    );
  });

  it('writes nothing for a direct notice without a recipient', async () => {
    const { create, client } = tx();
    await expect(
      enqueueNotice(client, 't', { ...base, type: 'REQUEST_CANCELLED' }),
    ).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('never tells people about their own action', async () => {
    const { create, client } = tx();
    await expect(
      enqueueNotice(client, 't', {
        ...base,
        type: 'REQUEST_REASSIGNED',
        recipientUserId: 'u1',
        actorUserId: 'u1',
      }),
    ).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('writes a reassignment to somebody else', async () => {
    const { create, client } = tx();
    await expect(
      enqueueNotice(client, 't', {
        ...base,
        type: 'REQUEST_REASSIGNED',
        recipientUserId: 'u2',
        actorUserId: 'u1',
      }),
    ).resolves.toBe(true);
    expect(create.mock.calls[0][0].data.payload.recipientUserId).toBe('u2');
  });
});

describe('enqueueClosedNotice (the assignee, when the close was not theirs)', () => {
  const closed = {
    id: 'req-1',
    folio: 7,
    subtype: 'DELIVERY_ZONE',
    assigneeUserId: 'luis' as string | null,
  };

  it('tells the assignee, with the cause and a per-request dedup key', async () => {
    const { create, client } = tx();
    await expect(
      enqueueClosedNotice(client, 't', closed, 'SIBLING_RESOLVED', 'ana'),
    ).resolves.toBe(true);
    expect(create.mock.calls[0][0].data.payload).toMatchObject({
      type: 'REQUEST_CANCELLED',
      requestId: 'req-1',
      recipientUserId: 'luis',
      actorUserId: 'ana',
      cause: 'SIBLING_RESOLVED',
      dedupKey: 'closed:req-1',
    });
  });

  it('never tells the person who closed it', async () => {
    const { create, client } = tx();
    await expect(
      enqueueClosedNotice(client, 't', closed, 'RESOLVED_BY_OTHER', 'luis'),
    ).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('tells nobody about a request nobody had taken', async () => {
    const { create, client } = tx();
    await expect(
      enqueueClosedNotice(
        client,
        't',
        { ...closed, assigneeUserId: null },
        'CANCELLED_BY_OTHER',
        'ana',
      ),
    ).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
