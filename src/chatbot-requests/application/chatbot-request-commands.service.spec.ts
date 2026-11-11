import {
  ChatbotRequestCommandError,
  ChatbotRequestCommandsService,
  type ChatbotRequestCommandStore,
  type ChatbotRequestResolver,
  type ChatbotRequestRow,
  type ChatbotRequestView,
  type ResolveAction,
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
    conversationRef: 'wa:525512345678',
    assigneeUserId: null,
    assigneeDisplayName: null,
    claimedAt: null,
    overdueAt: null,
    closedAt: null,
    humanDecisionId: null,
    deliveryZoneRequestId: null,
    receiptEvidenceId: null,
    ...over,
  };
}

const noResolver: ChatbotRequestResolver = {
  resolve: () => Promise.reject(new Error('resolver not expected')),
};

/** In-memory store that records the order of every port call. */
function fakeStore(
  initial: ChatbotRequestRow | null,
  zone: {
    siblings: ChatbotRequestRow[];
    impact: {
      validationId: string;
      requests: number;
      customers: number;
      setVersion: number;
    };
  } | null = null,
) {
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
    applyPatch: (locked, patch, event) => {
      calls.push(`applyPatch:${locked.id}`);
      applied.push({ id: locked.id, patch, event });
      if (current?.id === locked.id) {
        current = { ...locked, ...patch } as ChatbotRequestRow;
      }
      return Promise.resolve();
    },
    refreshGroups: (keys) => {
      calls.push(`refreshGroups:${keys.join(',')}`);
      return Promise.resolve();
    },
    enqueueAnswered: (ids) => {
      calls.push(`enqueueAnswered:${ids.join(',')}`);
      return Promise.resolve();
    },
    enqueueCancelled: (id, reason, customerNote) => {
      calls.push(`enqueueCancelled:${id}:${reason}:${customerNote ?? ''}`);
      return Promise.resolve();
    },
    lockZoneOf: () => {
      calls.push('lockZoneOf');
      return Promise.resolve();
    },
    lockZoneSet: () => {
      calls.push('lockZoneSet');
      return Promise.resolve(zone);
    },
    readZoneImpact: () =>
      Promise.resolve({ found: true, impact: zone?.impact ?? null }),
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
    const view = await new ChatbotRequestCommandsService(
      store,
      noResolver,
    ).execute(input());

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
    const service = new ChatbotRequestCommandsService(store, noResolver);
    const first = await service.execute(input());
    calls.length = 0;

    await expect(service.execute(input())).resolves.toEqual(first);
    expect(calls).not.toContain('lockRequest');
    expect(calls).not.toContain('apply');
  });

  it('answers 409 IDEMPOTENCY_CONFLICT for the same key with another body', async () => {
    const { store } = fakeStore(row());
    const service = new ChatbotRequestCommandsService(store, noResolver);
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
      new ChatbotRequestCommandsService(store, noResolver).execute(input()),
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
      new ChatbotRequestCommandsService(store, noResolver).execute(
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
    const service = new ChatbotRequestCommandsService(store, noResolver);

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
    const { store, applied, calls } = fakeStore(row());
    const view = await new ChatbotRequestCommandsService(
      store,
      noResolver,
    ).execute(
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
    // §12.14: the notice joins the transaction, before the group refresh.
    const notice = calls.indexOf(
      'enqueueCancelled:req-1:NOT_ACTIONABLE:No podemos ayudar con eso.',
    );
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(
      calls.findIndex((call) => call.startsWith('refreshGroups')),
    );
  });

  it('enqueues no feed item for claim, release or reassign', async () => {
    const { store, calls } = fakeStore(row());
    await new ChatbotRequestCommandsService(store, noResolver).execute(
      input({ command: { kind: 'claim' } }),
    );
    expect(calls.some((call) => call.startsWith('enqueue'))).toBe(false);
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
        new ChatbotRequestCommandsService(denied.store, noResolver).execute(
          input({ expectedVersion: 2, command: { kind: 'release' } }),
        ),
      ),
    ).resolves.toMatchObject({ code: 'NOT_ASSIGNEE', httpStatus: 403 });

    const allowed = fakeStore(held);
    await expect(
      new ChatbotRequestCommandsService(allowed.store, noResolver).execute(
        input({
          expectedVersion: 2,
          actorCanReassign: true,
          command: { kind: 'release' },
        }),
      ),
    ).resolves.toMatchObject({ status: 'NEW', assignee: null, version: 3 });
  });

  describe('resolve (unit 3)', () => {
    const decision = (over: Partial<ChatbotRequestRow> = {}) =>
      row({
        kind: 'DECISION',
        subtype: 'RESTOCK',
        humanDecisionId: 'hd-1',
        ...over,
      });
    const restock = (over: Partial<StaffCommandInput> = {}) =>
      input({
        actorCanResolveSubtype: () => true,
        command: {
          kind: 'resolve',
          action: { type: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 7 },
        },
        ...over,
      });
    const okResolver = () => {
      const seen: unknown[] = [];
      const resolver: ChatbotRequestResolver = {
        resolve: (call) => {
          seen.push(call);
          return Promise.resolve();
        },
      };
      return { resolver, seen };
    };

    it('closes the request, then calls the wrapped use case, then refreshes the group', async () => {
      const { store, calls, applied } = fakeStore(decision());
      const { resolver, seen } = okResolver();
      const view = await new ChatbotRequestCommandsService(
        store,
        resolver,
      ).execute(restock({ actorIsSuperAdmin: true }));

      expect(calls).toEqual([
        'begin',
        expect.stringContaining('lockKey'),
        'findReceipt',
        'findActor',
        'lockZoneOf',
        'lockRequest',
        'applyPatch:req-1',
        // After the state change and the wrapped write, before the group.
        'enqueueAnswered:req-1',
        'refreshGroups:525512345678',
        'saveReceipt',
        'commit',
      ]);
      expect(view).toMatchObject({ status: 'RESOLVED', version: 2 });
      expect(applied[0]).toMatchObject({
        patch: {
          status: 'RESOLVED',
          assigneeUserId: ANA.userId,
          resolution: { action: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 7 },
        },
        event: {
          type: 'RESOLVED',
          data: { action: 'PROVIDE_RESTOCK_ESTIMATE' },
        },
      });
      expect(seen).toEqual([
        expect.objectContaining({
          actor: ANA,
          actorIsSuperAdmin: true,
          resolutionKey: '5f0b2c1e-6a43-4f7e-9c1d-2b3a4c5d6e7f',
        }),
      ]);
    });

    it('refuses a non-decision and an action of another subtype without writing', async () => {
      const clarification = fakeStore(row());
      expect(
        await failure(
          new ChatbotRequestCommandsService(
            clarification.store,
            noResolver,
          ).execute(restock()),
        ),
      ).toMatchObject({
        code: 'ACTION_NOT_ALLOWED',
        httpStatus: 422,
        current: { version: 1, status: 'NEW', claimedBy: null },
      });

      const wrongFamily = fakeStore(decision());
      const error = await failure(
        new ChatbotRequestCommandsService(
          wrongFamily.store,
          noResolver,
        ).execute(
          input({
            actorCanResolveSubtype: () => true,
            command: {
              kind: 'resolve',
              action: { type: 'CONFIRM_RECEIPT', amountCents: 100 },
            },
          }),
        ),
      );
      expect(error).toMatchObject({ code: 'ACTION_NOT_ALLOWED' });
      for (const { calls } of [clarification, wrongFamily]) {
        expect(calls.some((call) => call.startsWith('applyPatch'))).toBe(false);
      }
    });

    it('answers the staff conflict codes before touching the wrapped row', async () => {
      const held = fakeStore(
        decision({
          status: 'IN_PROGRESS',
          assigneeUserId: LUIS.userId,
          assigneeDisplayName: LUIS.displayName,
          claimedAt: new Date(),
        }),
      );
      expect(
        await failure(
          new ChatbotRequestCommandsService(held.store, noResolver).execute(
            restock(),
          ),
        ),
      ).toMatchObject({ code: 'REQUEST_CLAIMED_BY_OTHER', httpStatus: 409 });
      const stale = fakeStore(decision({ version: 4 }));
      expect(
        await failure(
          new ChatbotRequestCommandsService(stale.store, noResolver).execute(
            restock(),
          ),
        ),
      ).toMatchObject({ code: 'VERSION_CONFLICT', httpStatus: 409 });
    });

    it('adds the request state to an error the wrapped use case threw', async () => {
      const { store } = fakeStore(decision());
      const resolver: ChatbotRequestResolver = {
        resolve: () =>
          Promise.reject(
            new ChatbotRequestCommandError('VERSION_CONFLICT', 409),
          ),
      };
      const error = await failure(
        new ChatbotRequestCommandsService(store, resolver).execute(restock()),
      );
      expect(error).toMatchObject({
        code: 'VERSION_CONFLICT',
        current: { version: 1, status: 'NEW' },
      });
    });

    it.each([
      ['UNAUTHORIZED', 401],
      ['FORBIDDEN', 403],
      ['NOT_FOUND', 404],
      ['VALIDATION_ERROR', 400],
    ] as const)(
      'attaches current to a %s raised by the wrapped use case',
      async (code, status) => {
        const { store } = fakeStore(decision());
        const resolver: ChatbotRequestResolver = {
          resolve: () =>
            Promise.reject(new ChatbotRequestCommandError(code, status)),
        };
        const error = await failure(
          new ChatbotRequestCommandsService(store, resolver).execute(restock()),
        );
        expect(error).toMatchObject({
          code,
          httpStatus: status,
          current: { version: 1, status: 'NEW', claimedBy: null },
        });
      },
    );

    describe('legacy permission per subtype', () => {
      const subtypes = [
        ['RESTOCK', restockAction()],
        [
          'EXPIRATION',
          { type: 'REPORT_EXPIRATION_UNAVAILABLE' } as ResolveAction,
        ],
        [
          'DELIVERY_ZONE',
          {
            type: 'REJECT_DELIVERY_ZONE',
            expectedZoneSetVersion: 1,
          } as ResolveAction,
        ],
        [
          'TRANSFER_RECEIPT',
          { type: 'CONFIRM_RECEIPT', amountCents: 100 } as ResolveAction,
        ],
      ] as const;

      function restockAction(): ResolveAction {
        return { type: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 7 };
      }

      it.each(subtypes)(
        'answers 403 INSUFFICIENT_PERMISSIONS for %s without writing, after loading the row',
        async (subtype, action) => {
          const { store, calls } = fakeStore(decision({ subtype }));
          const seen: string[] = [];
          const error = await failure(
            new ChatbotRequestCommandsService(store, noResolver).execute(
              input({
                actorCanResolveSubtype: (asked) => {
                  seen.push(asked);
                  return false;
                },
                command: { kind: 'resolve', action },
              }),
            ),
          );
          expect(error).toMatchObject({
            code: 'INSUFFICIENT_PERMISSIONS',
            httpStatus: 403,
          });
          expect(error.current).toBeUndefined();
          expect(seen).toEqual([subtype]);
          expect(calls).toContain('lockRequest');
          expect(calls.some((call) => call.startsWith('applyPatch'))).toBe(
            false,
          );
          expect(calls).not.toContain('saveReceipt');
          expect(calls.some((call) => call.startsWith('refreshGroups'))).toBe(
            false,
          );
        },
      );

      it.each([
        ['CLARIFICATION', 'UNKNOWN_QUESTION'],
        ['CONVERSATION', 'TALK_TO_HUMAN'],
        ['CONVERSATION', 'COMPLAINT'],
        ['DECISION', 'DISCOUNT'],
      ] as const)(
        'answers 422 ACTION_NOT_ALLOWED for %s/%s before asking for the permission, even to a caller that is denied',
        async (kind, subtype) => {
          const { store, calls } = fakeStore(decision({ kind, subtype }));
          const asked = jest.fn(() => false);
          const error = await failure(
            new ChatbotRequestCommandsService(store, noResolver).execute(
              input({
                actorCanResolveSubtype: asked,
                command: { kind: 'resolve', action: restockAction() },
              }),
            ),
          );
          expect(error).toMatchObject({
            code: 'ACTION_NOT_ALLOWED',
            httpStatus: 422,
            current: { version: 1, status: 'NEW', claimedBy: null },
          });
          expect(asked).not.toHaveBeenCalled();
          expect(calls).toContain('lockRequest');
          expect(calls.some((call) => call.startsWith('applyPatch'))).toBe(
            false,
          );
          expect(calls).not.toContain('saveReceipt');
        },
      );

      it('fails closed when the caller did not say what the actor can resolve', async () => {
        const { store } = fakeStore(decision());
        const error = await failure(
          new ChatbotRequestCommandsService(store, noResolver).execute(
            input({
              command: { kind: 'resolve', action: restockAction() },
            }),
          ),
        );
        expect(error).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
      });

      it('answers 404 for a missing row before asking for the permission', async () => {
        const { store } = fakeStore(null);
        const asked = jest.fn(() => false);
        const error = await failure(
          new ChatbotRequestCommandsService(store, noResolver).execute(
            input({
              actorCanResolveSubtype: asked,
              command: { kind: 'resolve', action: restockAction() },
            }),
          ),
        );
        expect(error).toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(asked).not.toHaveBeenCalled();
      });

      it('does not decide on state first: a closed request still answers 403', async () => {
        const { store } = fakeStore(decision({ status: 'RESOLVED' }));
        const error = await failure(
          new ChatbotRequestCommandsService(store, noResolver).execute(
            input({
              actorCanResolveSubtype: () => false,
              command: { kind: 'resolve', action: restockAction() },
            }),
          ),
        );
        expect(error).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
      });
    });

    describe('delivery zone', () => {
      const zoneRow = (id: string, key: string, over = {}) =>
        row({
          id,
          kind: 'DECISION',
          subtype: 'DELIVERY_ZONE',
          customerKey: key,
          deliveryZoneRequestId: `dzr-${id}`,
          ...over,
        });
      const impact = {
        validationId: 'v-1',
        requests: 3,
        customers: 3,
        setVersion: 7,
      };
      const approve = (expectedZoneSetVersion: number) =>
        input({
          actorCanResolveSubtype: () => true,
          command: {
            kind: 'resolve',
            action: {
              type: 'APPROVE_DELIVERY_ZONE',
              settings: { type: 'FREE', surchargeCents: null, etaDays: 2 },
              expectedZoneSetVersion,
            },
          },
        });

      it('answers ZONE_SET_CHANGED with the new zoneImpact and writes nothing', async () => {
        const main = zoneRow('req-1', '5200000001');
        const { store, calls } = fakeStore(main, { siblings: [main], impact });
        const error = await failure(
          new ChatbotRequestCommandsService(store, noResolver).execute(
            approve(6),
          ),
        );
        expect(error).toMatchObject({
          code: 'ZONE_SET_CHANGED',
          httpStatus: 409,
          current: { version: 1, status: 'NEW', zoneImpact: impact },
        });
        expect(calls.some((call) => call.startsWith('applyPatch'))).toBe(false);
      });

      it('closes every sibling with SIBLING_RESOLVED and refreshes groups in sorted order', async () => {
        const main = zoneRow('req-2', '5200000009');
        const siblings = [
          zoneRow('req-1', '5200000005'),
          main,
          zoneRow('req-3', '5200000001'),
        ];
        const { store, calls, applied } = fakeStore(main, { siblings, impact });
        const { resolver } = okResolver();
        await new ChatbotRequestCommandsService(store, resolver).execute({
          ...approve(7),
          requestId: 'req-2',
        });

        expect(calls.filter((call) => call.startsWith('applyPatch'))).toEqual([
          'applyPatch:req-2',
          'applyPatch:req-1',
          'applyPatch:req-3',
        ]);
        // One answer per customer (R9): the acting request, then its siblings.
        expect(calls).toContain('enqueueAnswered:req-2,req-1,req-3');
        expect(calls.indexOf('enqueueAnswered:req-2,req-1,req-3')).toBeLessThan(
          calls.indexOf('refreshGroups:5200000009,5200000005,5200000001'),
        );
        expect(applied[1]).toMatchObject({
          patch: {
            status: 'RESOLVED',
            resolution: { action: 'SIBLING_RESOLVED', viaRequestId: 'req-2' },
          },
          event: {
            type: 'RESOLVED',
            data: { action: 'SIBLING_RESOLVED', viaRequestId: 'req-2' },
          },
        });
      });
    });
  });

  it('reads the zone impact and maps missing and non-zone requests', async () => {
    const impact = {
      validationId: 'v-1',
      requests: 2,
      customers: 2,
      setVersion: 3,
    };
    const zone = fakeStore(row(), { siblings: [], impact });
    await expect(
      new ChatbotRequestCommandsService(zone.store, noResolver).zoneImpact('x'),
    ).resolves.toEqual(impact);
    const plain = fakeStore(row());
    expect(
      await failure(
        new ChatbotRequestCommandsService(plain.store, noResolver).zoneImpact(
          'x',
        ),
      ),
    ).toMatchObject({ code: 'ACTION_NOT_ALLOWED', httpStatus: 422 });
  });

  it('answers 401 when the actor account no longer exists', async () => {
    const { store } = fakeStore(row());
    const error = await failure(
      new ChatbotRequestCommandsService(store, noResolver).execute(
        input({ actorUserId: 'u-ghost' }),
      ),
    );
    expect(error).toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 });
  });
});
