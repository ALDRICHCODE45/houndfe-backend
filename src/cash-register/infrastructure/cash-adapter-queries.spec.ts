/**
 * cash-register-closing / S10 — direct characterization of the extracted
 * query module.
 *
 * Pins per-row visibility (register list + session owner/audit), the blind
 * pre-submission projection that hides movements, pagination with a total
 * computed before slicing, and closing reads. Invoked directly; the facade's
 * active-membership gate is deliberately not part of this module.
 */
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { CashActor } from '../cash-application.port';
import {
  queryClosing,
  queryClosings,
  queryRegisters,
  querySession,
  querySessions,
} from './cash-adapter-queries';
import {
  actor,
  asItems,
  asJson,
  makeTenantHarness,
  seedActors,
  type Host,
} from './cash-adapter.test-support';

function seedRegister(
  host: Host,
  id: string,
  name: string,
  isActive = true,
): void {
  host.db.registers.push({
    id,
    tenantId: host.tenantId,
    name,
    isActive,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function seedSession(host: Host, over: Record<string, unknown> = {}): string {
  host.db.sessions.push({
    id: 's-1',
    tenantId: host.tenantId,
    registerId: 'reg-1',
    cashierUserId: 'u1',
    openingCents: 1000,
    status: 'OPEN',
    openedAt: new Date(),
    frozenAt: null,
    submittedAt: null,
    closedAt: null,
    drawerReleasedAt: null,
    openingHandoverId: null,
    expectedJson: null,
    ...over,
  });
  return (over.id as string | undefined) ?? 's-1';
}

function seedMovement(host: Host, sessionId: string): void {
  host.db.movements.push({
    id: 'm-1',
    tenantId: host.tenantId,
    sessionId,
    kind: 'CASH_IN',
    deltaCents: 500,
    method: 'CASH',
    channelKey: 'CASH',
    channelLabel: 'Efectivo',
    sourceType: 'MANUAL',
    sourceId: 'src-1',
    actorUserId: 'u1',
    reason: 'seed',
    occurredAt: new Date(),
    createdAt: new Date(),
  });
}

function conditionalRegisterReader(userId: string): CashActor {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  can('read', 'CashRegister', { isActive: true });
  return { userId, ability: build() };
}

describe('cash-adapter-queries — direct module contract', () => {
  it('lists tenant registers ordered by name', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedRegister(host, 'reg-b', 'Caja B');
    seedRegister(host, 'reg-a', 'Caja A');

    const doc = await queryRegisters(tx, host.tenantId, actor('u1'));

    const items = asItems(doc.items);
    expect(items).toHaveLength(2);
    expect(items[0].name).toBe('Caja A');
    expect(items[1].name).toBe('Caja B');
  });

  it('filters registers per row with a conditional read rule', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedRegister(host, 'reg-active', 'Caja Activa', true);
    seedRegister(host, 'reg-inactive', 'Caja Inactiva', false);

    const doc = await queryRegisters(
      tx,
      host.tenantId,
      conditionalRegisterReader('u1'),
    );

    const items = asItems(doc.items);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('reg-active');
  });

  it('denies register listing without the read capability', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();

    await expect(
      queryRegisters(tx, host.tenantId, actor('u1', [])),
    ).rejects.toMatchObject({ code: 'CASH_PERMISSION_DENIED' });
  });

  it('returns a blind projection that hides movements before submission', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);
    seedMovement(host, sessionId);

    const doc = await querySession(tx, host.tenantId, actor('u1'), sessionId);

    expect(asJson(doc.session).blind).toBe(true);
    expect(asJson(doc.session).expectedCashCents).toBeUndefined();
    expect(doc.movements).toEqual([]);
    expect(doc.channelSnapshot).toBeNull();
  });

  it('reveals expected cash and movements after a declaration is submitted', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host, {
      status: 'SUBMITTED',
      submittedAt: new Date(),
      expectedJson: {
        cashExpectedCents: 1500,
        frozenAt: new Date().toISOString(),
        channels: [
          {
            channelKey: 'CASH',
            channelLabel: 'Efectivo',
            method: 'CASH',
            expectedCents: 1500,
          },
        ],
      },
    });
    seedMovement(host, sessionId);
    host.db.counts.push({
      id: 'c-1',
      tenantId: host.tenantId,
      sessionId,
      kind: 'DECLARATION',
      revision: 1,
      actorUserId: 'u1',
      linesJson: [{ channelKey: 'CASH', amountCents: 1500 }],
      denominationsJson: null,
      notes: null,
      createdAt: new Date(),
    });

    const doc = await querySession(tx, host.tenantId, actor('u1'), sessionId);

    expect(asJson(doc.session).blind).toBe(false);
    expect(asJson(doc.session).expectedCashCents).toBe(1500);
    expect(asItems(doc.movements)).toHaveLength(1);
    expect(asItems(doc.counts)).toHaveLength(1);
  });

  it('denies a non-owner session read without audit visibility', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedSession(host);

    await expect(
      querySession(
        tx,
        host.tenantId,
        actor('u2', [['read', 'CashSession']]),
        's-1',
      ),
    ).rejects.toMatchObject({ code: 'CASH_PERMISSION_DENIED' });
  });

  it('fails closed on an unknown session', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();

    await expect(
      querySession(tx, host.tenantId, actor('u1'), 'missing'),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_FOUND' });
  });

  it('paginates session lists with the total computed before slicing', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedSession(host, {
      id: 's-1',
      openedAt: new Date('2026-01-01T10:00:00Z'),
    });
    seedSession(host, {
      id: 's-2',
      openedAt: new Date('2026-01-01T11:00:00Z'),
    });
    seedSession(host, {
      id: 's-3',
      openedAt: new Date('2026-01-01T12:00:00Z'),
    });

    const first = asJson(
      await querySessions(tx, host.tenantId, actor('u1'), {
        kind: 'SESSIONS',
        page: { page: 1, limit: 2 },
      }),
    );
    expect(first.total).toBe(3);
    expect(asItems(first.items)).toHaveLength(2);
    expect(asItems(first.items)[0].id).toBe('s-3');

    const second = asJson(
      await querySessions(tx, host.tenantId, actor('u1'), {
        kind: 'SESSIONS',
        page: { page: 2, limit: 2 },
      }),
    );
    expect(asItems(second.items)).toHaveLength(1);

    await expect(
      querySessions(tx, host.tenantId, actor('u1'), {
        kind: 'SESSIONS',
        page: { page: 0, limit: 2 },
      }),
    ).rejects.toMatchObject({ code: 'CASH_QUERY_INVALID_PAGE' });
  });

  it('lists closings and returns a closing document with its frozen snapshot', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedSession(host, { status: 'CLOSED', closedAt: new Date() });
    host.db.closings.push({
      id: 'cl-1',
      tenantId: host.tenantId,
      sessionId: 's-1',
      folio: 'CC-1',
      closedByUserId: 'u1',
      snapshotJson: { sessionId: 's-1', folio: 'CC-1' },
      createdAt: new Date(),
    });

    const list = asJson(
      await queryClosings(tx, host.tenantId, actor('u1'), {
        page: 1,
        limit: 20,
      }),
    );
    expect(list.total).toBe(1);
    expect(asItems(list.items)[0].folio).toBe('CC-1');

    const doc = await queryClosing(tx, host.tenantId, actor('u1'), 'cl-1');
    expect(doc.folio).toBe('CC-1');
    expect(asJson(doc.snapshot).sessionId).toBe('s-1');

    await expect(
      queryClosing(tx, host.tenantId, actor('u1'), 'missing'),
    ).rejects.toMatchObject({ code: 'CASH_CLOSING_NOT_FOUND' });
  });

  describe('display fields (fe-design-pass T1/S1, S2)', () => {
    it('adds openedAt, closedAt and the cashier name to session list items', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedActors(host, ['u1', 'u2']);
      seedSession(host, {
        id: 's-closed',
        cashierUserId: 'u2',
        status: 'CLOSED',
        openedAt: new Date('2026-01-01T10:00:00Z'),
        closedAt: new Date('2026-01-01T18:30:00Z'),
      });
      seedSession(host, {
        id: 's-open',
        cashierUserId: 'u1',
        openedAt: new Date('2026-01-02T09:00:00Z'),
      });
      const users = jest.spyOn(tx.user, 'findMany');
      const userFirst = jest.spyOn(tx.user, 'findFirst');

      const items = asItems(
        asJson(
          await querySessions(tx, host.tenantId, actor('u1'), {
            kind: 'SESSIONS',
            page: { page: 1, limit: 25 },
          }),
        ).items,
      );

      expect(
        items.map((item) => [
          item.id,
          item.openedAt,
          item.closedAt,
          item.cashierDisplayName,
        ]),
      ).toEqual([
        ['s-open', '2026-01-02T09:00:00.000Z', null, 'Name u1'],
        [
          's-closed',
          '2026-01-01T10:00:00.000Z',
          '2026-01-01T18:30:00.000Z',
          'Name u2',
        ],
      ]);
      // One batched user load for the whole page, never one per row.
      expect(users).toHaveBeenCalledTimes(1);
      expect(userFirst).not.toHaveBeenCalled();
    });

    it('keeps every existing list key and stays blind for the declarant', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedActors(host, ['u1']);
      seedSession(host);

      const [item] = asItems(
        asJson(
          await querySessions(tx, host.tenantId, actor('u1'), {
            kind: 'SESSIONS',
            page: { page: 1, limit: 25 },
          }),
        ).items,
      );

      expect(Object.keys(item).sort()).toEqual([
        'blind',
        'cashierDisplayName',
        'cashierUserId',
        'closedAt',
        'drawerReleasedAt',
        'frozenAt',
        'id',
        'openedAt',
        'openingCents',
        'registerId',
        'status',
        'tenantId',
      ]);
      expect(item.blind).toBe(true);
    });

    it('returns a null cashier name when the user row is missing', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedSession(host, { cashierUserId: 'u-gone' });

      const listItem = asItems(
        asJson(
          await querySessions(tx, host.tenantId, actor('u1'), {
            kind: 'SESSIONS',
            page: { page: 1, limit: 25 },
          }),
        ).items,
      )[0];
      const detail = asJson(
        (await querySession(tx, host.tenantId, actor('u1'), 's-1')).session,
      );

      expect(listItem.cashierDisplayName).toBeNull();
      expect(detail.cashierDisplayName).toBeNull();
    });

    it('adds openedAt, closedAt and the cashier name to the session detail', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedActors(host, ['u1', 'u2']);
      seedSession(host, {
        cashierUserId: 'u2',
        status: 'CLOSED',
        openedAt: new Date('2026-01-01T10:00:00Z'),
        closedAt: new Date('2026-01-01T18:30:00Z'),
      });

      const session = asJson(
        (await querySession(tx, host.tenantId, actor('u1'), 's-1')).session,
      );

      expect(session).toMatchObject({
        cashierUserId: 'u2',
        openedAt: '2026-01-01T10:00:00.000Z',
        closedAt: '2026-01-01T18:30:00.000Z',
        cashierDisplayName: 'Name u2',
      });
    });
  });

  describe('DB-side list pagination (cash-redesign-reads S5)', () => {
    function seedThree(host: Host): void {
      seedSession(host, {
        id: 's-1',
        cashierUserId: 'u1',
        openedAt: new Date('2026-01-01T10:00:00Z'),
      });
      seedSession(host, {
        id: 's-2',
        cashierUserId: 'u2',
        openedAt: new Date('2026-01-01T11:00:00Z'),
      });
      seedSession(host, {
        id: 's-3',
        cashierUserId: 'u1',
        openedAt: new Date('2026-01-01T12:00:00Z'),
      });
    }

    it('pushes skip/take/count to the DB for unconditional audit grants', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedThree(host);
      const findMany = jest.spyOn(tx.cashSession, 'findMany');
      const count = jest.spyOn(tx.cashSession, 'count');

      const doc = asJson(
        await querySessions(tx, host.tenantId, actor('u1'), {
          kind: 'SESSIONS',
          page: { page: 2, limit: 1 },
        }),
      );

      expect(doc.total).toBe(3);
      expect(asItems(doc.items).map((item) => item.id)).toEqual(['s-2']);
      expect(count).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 1, take: 1 }),
      );
    });

    it('scopes own-only unconditional readers in the DB where clause', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedThree(host);
      const findMany = jest.spyOn(tx.cashSession, 'findMany');

      const doc = asJson(
        await querySessions(
          tx,
          host.tenantId,
          actor('u1', [['read', 'CashSession']]),
          { kind: 'SESSIONS', page: { page: 1, limit: 25 } },
        ),
      );

      expect(doc.total).toBe(2);
      expect(asItems(doc.items).map((item) => item.id)).toEqual(['s-3', 's-1']);
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 25 }),
      );
    });

    it('keeps the per-row path (no DB skip/take) for conditional grants', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedThree(host);
      const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
      can('read', 'CashSession');
      can('read', 'CashSessionAudit', { cashierUserId: 'u2' });
      const conditional: CashActor = { userId: 'u1', ability: build() };
      const findMany = jest.spyOn(tx.cashSession, 'findMany');

      const doc = asJson(
        await querySessions(tx, host.tenantId, conditional, {
          kind: 'SESSIONS',
          page: { page: 1, limit: 25 },
        }),
      );

      expect(asItems(doc.items).map((item) => item.id)).toEqual([
        's-3',
        's-2',
        's-1',
      ]);
      expect(findMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ take: expect.anything() }),
      );
    });

    it('pushes closing pagination to the DB and honors cashierUserId', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedThree(host);
      for (const [index, sessionId] of ['s-1', 's-2', 's-3'].entries()) {
        host.db.closings.push({
          id: `cl-${index + 1}`,
          tenantId: host.tenantId,
          sessionId,
          folio: `CC-${index + 1}`,
          closedByUserId: 'u9',
          snapshotJson: {},
          createdAt: new Date(Date.UTC(2026, 0, 2, index)),
        });
      }
      const findMany = jest.spyOn(tx.cashClosing, 'findMany');
      const count = jest.spyOn(tx.cashClosing, 'count');

      const doc = asJson(
        await queryClosings(tx, host.tenantId, actor('u9'), {
          page: 1,
          limit: 1,
          cashierUserId: 'u1',
        }),
      );

      expect(doc.total).toBe(2);
      expect(asItems(doc.items).map((item) => item.id)).toEqual(['cl-3']);
      expect(count).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 1 }),
      );
    });
  });

  describe('closing list fields (cash-redesign-reads T2/S7)', () => {
    function seedClosed(host: Host): void {
      seedActors(host, ['u1', 'u2', 'u9']);
      seedRegister(host, 'reg-1', 'Caja 1');
      seedRegister(host, 'reg-2', 'Caja 2');
      const rows: Array<[string, string, string, Record<string, unknown>]> = [
        [
          's-1',
          'reg-1',
          'u1',
          {
            comparison: { declarationDifferenceCents: -500 },
            declaredCents: 1,
            expectedCents: 1,
          },
        ],
        ['s-2', 'reg-2', 'u2', { declaredCents: 1200, expectedCents: 1000 }],
        ['s-3', 'reg-1', 'u1', {}],
      ];
      for (const [
        index,
        [id, registerId, cashier, snapshot],
      ] of rows.entries()) {
        seedSession(host, {
          id,
          registerId,
          cashierUserId: cashier,
          status: 'CLOSED',
          openedAt: new Date(Date.UTC(2026, 0, 1, index)),
          closedAt: new Date(Date.UTC(2026, 0, 1, index, 30)),
        });
        host.db.closings.push({
          id: `cl-${index + 1}`,
          tenantId: host.tenantId,
          sessionId: id,
          folio: `CC-${index + 1}`,
          closedByUserId: 'u9',
          snapshotJson: snapshot,
          createdAt: new Date(Date.UTC(2026, 0, 2, index)),
        });
      }
    }

    const expectedItems = [
      {
        id: 'cl-3',
        register: { id: 'reg-1', name: 'Caja 1' },
        cashier: { userId: 'u1', displayName: 'Name u1' },
        differenceCents: null,
      },
      {
        id: 'cl-2',
        register: { id: 'reg-2', name: 'Caja 2' },
        cashier: { userId: 'u2', displayName: 'Name u2' },
        differenceCents: 200,
      },
      {
        id: 'cl-1',
        register: { id: 'reg-1', name: 'Caja 1' },
        cashier: { userId: 'u1', displayName: 'Name u1' },
        differenceCents: -500,
      },
    ];

    it('adds register, cashier and the frozen difference on the DB path', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedClosed(host);

      const doc = asJson(
        await queryClosings(tx, host.tenantId, actor('u9'), {
          page: 1,
          limit: 25,
        }),
      );

      expect(asItems(doc.items)).toEqual(
        expectedItems.map((item): unknown => expect.objectContaining(item)),
      );
    });

    it('returns the same fields on the per-row (conditional grant) path', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedClosed(host);
      const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
      can('read', 'CashClosing');
      can('read', 'CashSessionAudit', { tenantId: host.tenantId });
      const conditional: CashActor = { userId: 'u9', ability: build() };

      const doc = asJson(
        await queryClosings(tx, host.tenantId, conditional, {
          page: 1,
          limit: 25,
        }),
      );

      expect(asItems(doc.items)).toEqual(
        expectedItems.map((item): unknown => expect.objectContaining(item)),
      );
    });

    it('batches the per-page lookups instead of reading per row', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedClosed(host);
      const sessions = jest.spyOn(tx.cashSession, 'findMany');
      const registers = jest.spyOn(tx.cashRegister, 'findMany');
      const users = jest.spyOn(tx.user, 'findMany');
      const findFirst = [
        jest.spyOn(tx.cashSession, 'findFirst'),
        jest.spyOn(tx.cashRegister, 'findFirst'),
        jest.spyOn(tx.user, 'findFirst'),
      ];

      await queryClosings(tx, host.tenantId, actor('u9'), {
        page: 1,
        limit: 25,
      });

      expect(sessions).toHaveBeenCalledTimes(1);
      expect(registers).toHaveBeenCalledTimes(1);
      expect(users).toHaveBeenCalledTimes(1);
      for (const spy of findFirst) {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it('exposes openedAt as null on an old snapshot and verbatim on a new one', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedSession(host, { status: 'CLOSED', closedAt: new Date() });
      host.db.closings.push({
        id: 'cl-old',
        tenantId: host.tenantId,
        sessionId: 's-1',
        folio: 'CC-old',
        closedByUserId: 'u1',
        snapshotJson: { sessionId: 's-1', folio: 'CC-old' },
        createdAt: new Date(),
      });
      seedSession(host, { id: 's-2', status: 'CLOSED', closedAt: new Date() });
      host.db.closings.push({
        id: 'cl-new',
        tenantId: host.tenantId,
        sessionId: 's-2',
        folio: 'CC-new',
        closedByUserId: 'u1',
        snapshotJson: {
          sessionId: 's-2',
          openedAt: '2026-01-01T09:00:00.000Z',
        },
        createdAt: new Date(),
      });

      const old = await queryClosing(tx, host.tenantId, actor('u1'), 'cl-old');
      const fresh = await queryClosing(
        tx,
        host.tenantId,
        actor('u1'),
        'cl-new',
      );

      expect(asJson(old.snapshot)).toEqual({
        sessionId: 's-1',
        folio: 'CC-old',
        openedAt: null,
      });
      expect(asJson(fresh.snapshot).openedAt).toBe('2026-01-01T09:00:00.000Z');
    });
  });
  describe('read-time names for old snapshots (pdf-a4-redesign T2/S1)', () => {
    const handoverRow = (over: Record<string, unknown> = {}) => ({
      handoverId: 'h-1',
      kind: 'WITHDRAWAL',
      declaredCents: 1000,
      receivedCents: 1000,
      senderUserId: 'u1',
      receiverUserId: 'u2',
      receiptActorUserId: 'u3',
      declaredAt: '2026-01-01T10:00:00.000Z',
      receivedAt: '2026-01-01T10:05:00.000Z',
      ...over,
    });

    function seedClosing(
      host: Host,
      snapshotJson: Record<string, unknown>,
      tenantId = host.tenantId,
    ): void {
      host.db.closings.push({
        id: 'cl-names',
        tenantId,
        sessionId: 's-1',
        folio: 'CC-names',
        closedByUserId: 'u1',
        snapshotJson: { sessionId: 's-1', folio: 'CC-names', ...snapshotJson },
        createdAt: new Date(),
      });
    }

    it('fills missing handover names with ONE batched users query and never rewrites the row', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedActors(host, ['u1', 'u2', 'u3']);
      seedSession(host, { status: 'CLOSED', closedAt: new Date() });
      seedClosing(host, { handovers: [handoverRow(), handoverRow()] });
      const findMany = jest.spyOn(tx.user, 'findMany');

      const doc = await queryClosing(
        tx,
        host.tenantId,
        actor('u1'),
        'cl-names',
      );

      const [first] = asItems(asJson(doc.snapshot).handovers);
      expect(first).toMatchObject({
        senderName: 'Name u1',
        receiverName: 'Name u2',
        receiptActorName: 'Name u3',
      });
      expect(findMany).toHaveBeenCalledTimes(1);
      const where = (
        findMany.mock.calls[0][0] as { where: { id: { in: string[] } } }
      ).where;
      expect([...where.id.in].sort()).toEqual(['u1', 'u2', 'u3']);
      expect(host.db.closings[0].snapshotJson).not.toHaveProperty(
        'handovers.0.senderName',
      );
    });

    it('keeps frozen names and skips the users query when nothing is missing', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedActors(host, ['u1', 'u2', 'u3']);
      seedSession(host, { status: 'CLOSED', closedAt: new Date() });
      seedClosing(host, {
        handovers: [
          handoverRow({
            senderName: 'Congelada Uno',
            receiverName: 'Congelada Dos',
            receiptActorName: 'Congelada Tres',
          }),
        ],
      });
      const findMany = jest.spyOn(tx.user, 'findMany');

      const doc = await queryClosing(
        tx,
        host.tenantId,
        actor('u1'),
        'cl-names',
      );

      expect(asItems(asJson(doc.snapshot).handovers)[0]).toMatchObject({
        senderName: 'Congelada Uno',
        receiverName: 'Congelada Dos',
        receiptActorName: 'Congelada Tres',
      });
      expect(findMany).not.toHaveBeenCalled();
    });

    it('leaves an unresolvable user nameless instead of inventing a value', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedActors(host, ['u1']);
      seedSession(host, { status: 'CLOSED', closedAt: new Date() });
      seedClosing(host, {
        handovers: [
          handoverRow({ receiverUserId: 'ghost', receiptActorUserId: null }),
        ],
      });

      const doc = await queryClosing(
        tx,
        host.tenantId,
        actor('u1'),
        'cl-names',
      );

      const [first] = asItems(asJson(doc.snapshot).handovers);
      expect(first.senderName).toBe('Name u1');
      expect(first).not.toHaveProperty('receiverName');
      expect(first).not.toHaveProperty('receiptActorName');
    });

    it('never looks up names for another tenant closing (not found, zero users queries)', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedActors(host, ['u1', 'u2', 'u3']);
      seedSession(host, { status: 'CLOSED', closedAt: new Date() });
      seedClosing(host, { handovers: [handoverRow()] }, 'other-tenant');
      const findMany = jest.spyOn(tx.user, 'findMany');
      const findFirst = jest.spyOn(tx.user, 'findFirst');

      await expect(
        queryClosing(tx, host.tenantId, actor('u1'), 'cl-names'),
      ).rejects.toMatchObject({ code: 'CASH_CLOSING_NOT_FOUND' });
      expect(findMany).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('also fills missing cashier/verifier/closer names on old snapshots', async () => {
      const { host, tenantPrisma } = makeTenantHarness();
      const tx = tenantPrisma.getClient();
      seedActors(host, ['u1', 'u2']);
      seedSession(host, { status: 'CLOSED', closedAt: new Date() });
      seedClosing(host, {
        cashierUserId: 'u1',
        verifierUserId: 'u2',
        closedByUserId: 'u2',
        closedByName: 'Ya congelado',
        handovers: [],
      });

      const snapshot = asJson(
        (await queryClosing(tx, host.tenantId, actor('u1'), 'cl-names'))
          .snapshot,
      );

      expect(snapshot).toMatchObject({
        cashierName: 'Name u1',
        verifierName: 'Name u2',
        closedByName: 'Ya congelado',
      });
    });
  });
});

/**
 * cash-register-held-by — `GET /cash-registers` reports, per register,
 * whether a session with an unreleased drawer holds it (the exact predicate
 * of the 422 `CASH_REGISTER_UNRELEASED_SESSION` opening guard, any status),
 * its status/openedAt for every caller, and `heldBy` (with the cashier name)
 * only when the caller may see that session under the GET /cash-sessions
 * visibility rule.
 */
describe('cash-adapter-queries — register drawer hold (cash-register-held-by)', () => {
  const CASHIER = [
    ['read', 'CashRegister'],
    ['read', 'CashSession'],
  ] as const;
  const AUDITOR = [
    ['read', 'CashRegister'],
    ['read', 'CashSession'],
    ['read', 'CashSessionAudit'],
  ] as const;
  // Audit grant WITHOUT read:CashSession: GET /cash-sessions answers 403 for
  // this caller, so the register list must not name the holder either.
  const AUDIT_ONLY = [
    ['read', 'CashRegister'],
    ['read', 'CashSessionAudit'],
  ] as const;

  const anyString: unknown = expect.any(String);

  async function registerItems(
    host: Host,
    tx: Parameters<typeof queryRegisters>[0],
    who: CashActor,
  ): Promise<Record<string, Record<string, unknown>>> {
    const doc = await queryRegisters(tx, host.tenantId, who);
    return Object.fromEntries(
      asItems(doc.items).map((item) => [item.id as string, item]),
    );
  }

  it('reports drawerHeld false and null hold fields with no or only released sessions', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedRegister(host, 'reg-empty', 'Caja A');
    seedRegister(host, 'reg-released', 'Caja B');
    seedSession(host, {
      id: 's-released',
      registerId: 'reg-released',
      status: 'CLOSED',
      closedAt: new Date(),
      drawerReleasedAt: new Date(),
    });

    const doc = await queryRegisters(tx, host.tenantId, actor('u1'));

    for (const item of asItems(doc.items)) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'createdAt',
          'drawerHeld',
          'drawerHeldSince',
          'drawerHeldStatus',
          'heldBy',
          'id',
          'isActive',
          'name',
        ].sort(),
      );
      expect(item).toMatchObject({
        drawerHeld: false,
        drawerHeldStatus: null,
        drawerHeldSince: null,
        heldBy: null,
      });
    }
  });

  it('holds the register for a CLOSED session whose drawer was never released', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedRegister(host, 'reg-1', 'Caja A');
    const openedAt = new Date('2026-11-26T09:12:00.000Z');
    seedSession(host, {
      status: 'CLOSED',
      openedAt,
      closedAt: new Date(),
      drawerReleasedAt: null,
    });

    const items = await registerItems(host, tx, actor('u1'));

    expect(items['reg-1']).toMatchObject({
      drawerHeld: true,
      drawerHeldStatus: 'CLOSED',
      drawerHeldSince: '2026-11-26T09:12:00.000Z',
    });
  });

  it("fills heldBy with byMe and the cashier name for the caller's own session", async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedRegister(host, 'reg-1', 'Caja A');
    const openedAt = new Date('2026-11-26T09:12:00.000Z');
    seedSession(host, { id: 's-own', cashierUserId: 'u1', openedAt });

    const items = await registerItems(host, tx, actor('u1', CASHIER));

    expect(items['reg-1']).toMatchObject({
      drawerHeld: true,
      drawerHeldStatus: 'OPEN',
      drawerHeldSince: '2026-11-26T09:12:00.000Z',
      heldBy: {
        sessionId: 's-own',
        status: 'OPEN',
        openedAt: '2026-11-26T09:12:00.000Z',
        cashierDisplayName: 'Name u1',
        byMe: true,
      },
    });
  });

  it("hides heldBy (and the name) for another cashier's session without the audit grant, but keeps status and since", async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1', 'u2']);
    seedRegister(host, 'reg-1', 'Caja A');
    const openedAt = new Date('2026-11-26T09:12:00.000Z');
    seedSession(host, {
      id: 's-other',
      cashierUserId: 'u2',
      status: 'COUNTING',
      openedAt,
      frozenAt: new Date(),
    });

    const items = await registerItems(host, tx, actor('u1', CASHIER));

    expect(items['reg-1']).toEqual({
      id: 'reg-1',
      name: 'Caja A',
      isActive: true,
      createdAt: anyString,
      drawerHeld: true,
      drawerHeldStatus: 'COUNTING',
      drawerHeldSince: '2026-11-26T09:12:00.000Z',
      heldBy: null,
    });
    expect(JSON.stringify(items['reg-1'])).not.toContain('Name u2');
  });

  it("fills heldBy for another cashier's session with read:CashSessionAudit", async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1', 'u2']);
    seedRegister(host, 'reg-1', 'Caja A');
    const openedAt = new Date('2026-11-26T09:12:00.000Z');
    seedSession(host, {
      id: 's-other',
      cashierUserId: 'u2',
      status: 'SUBMITTED',
      openedAt,
    });

    const items = await registerItems(host, tx, actor('u1', AUDITOR));

    expect(items['reg-1'].heldBy).toEqual({
      sessionId: 's-other',
      status: 'SUBMITTED',
      openedAt: '2026-11-26T09:12:00.000Z',
      cashierDisplayName: 'Name u2',
      byMe: false,
    });
  });

  it('hides heldBy from an audit grant without read:CashSession (same gate as GET /cash-sessions)', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1', 'u2']);
    seedRegister(host, 'reg-1', 'Caja A');
    const openedAt = new Date('2026-11-26T09:12:00.000Z');
    seedSession(host, {
      id: 's-other',
      cashierUserId: 'u2',
      status: 'SUBMITTED',
      openedAt,
    });

    const items = await registerItems(host, tx, actor('u1', AUDIT_ONLY));

    expect(items['reg-1']).toMatchObject({
      drawerHeld: true,
      drawerHeldStatus: 'SUBMITTED',
      drawerHeldSince: '2026-11-26T09:12:00.000Z',
      heldBy: null,
    });
    expect(JSON.stringify(items['reg-1'])).not.toContain('Name u2');
  });

  it('renders a null cashierDisplayName when the cashier user row is missing', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedRegister(host, 'reg-1', 'Caja A');
    seedSession(host, { id: 's-ghost', cashierUserId: 'u-ghost' });

    const items = await registerItems(host, tx, actor('u1', AUDITOR));

    expect(items['reg-1'].heldBy).toMatchObject({
      sessionId: 's-ghost',
      cashierDisplayName: null,
      byMe: false,
    });
  });

  it('reports the hold on an inactive register too', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedRegister(host, 'reg-1', 'Caja Inactiva', false);
    seedSession(host, { id: 's-1', status: 'SUBMITTED' });

    const items = await registerItems(host, tx, actor('u1'));

    expect(items['reg-1']).toMatchObject({
      isActive: false,
      drawerHeld: true,
      drawerHeldStatus: 'SUBMITTED',
      heldBy: { sessionId: 's-1' },
    });
  });

  it('picks the latest openedAt, then the highest id, when several unreleased sessions exist', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedRegister(host, 'reg-1', 'Caja A');
    seedRegister(host, 'reg-2', 'Caja B');
    const early = new Date('2026-11-26T08:00:00.000Z');
    const late = new Date('2026-11-26T10:00:00.000Z');
    seedSession(host, { id: 's-a-late', openedAt: late });
    seedSession(host, { id: 's-a-early', openedAt: early });
    seedSession(host, { id: 's-b-1', registerId: 'reg-2', openedAt: late });
    seedSession(host, { id: 's-b-2', registerId: 'reg-2', openedAt: late });
    seedSession(host, { id: 's-b-0', registerId: 'reg-2', openedAt: early });

    const items = await registerItems(host, tx, actor('u1'));

    expect(asJson(items['reg-1'].heldBy).sessionId).toBe('s-a-late');
    expect(items['reg-1'].drawerHeldSince).toBe(late.toISOString());
    expect(asJson(items['reg-2'].heldBy).sessionId).toBe('s-b-2');
  });

  it('only looks up holds for registers that passed the per-row read filter, in one batched query', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1', 'u2']);
    seedRegister(host, 'reg-active', 'Caja Activa', true);
    seedRegister(host, 'reg-active-2', 'Caja Activa 2', true);
    seedRegister(host, 'reg-inactive', 'Caja Inactiva', false);
    seedSession(host, { id: 's-1', registerId: 'reg-active' });
    seedSession(host, {
      id: 's-2',
      registerId: 'reg-active-2',
      cashierUserId: 'u2',
    });
    seedSession(host, { id: 's-3', registerId: 'reg-inactive' });
    const sessionsMany = jest.spyOn(tx.cashSession, 'findMany');
    const sessionsFirst = jest.spyOn(tx.cashSession, 'findFirst');
    const usersMany = jest.spyOn(tx.user, 'findMany');
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    can('read', 'CashRegister', { isActive: true });
    can('read', 'CashSession');

    const doc = await queryRegisters(tx, host.tenantId, {
      userId: 'u1',
      ability: build(),
    });

    const items = asItems(doc.items);
    expect(items.map((item) => item.id)).toEqual([
      'reg-active',
      'reg-active-2',
    ]);
    expect(items.map((item) => item.drawerHeld)).toEqual([true, true]);
    expect(asJson(items[0].heldBy).byMe).toBe(true);
    expect(items[1].heldBy).toBeNull();
    expect(sessionsMany).toHaveBeenCalledTimes(1);
    expect(sessionsFirst).not.toHaveBeenCalled();
    const where = asJson(asJson(sessionsMany.mock.calls[0][0]).where);
    expect(where).toEqual({
      tenantId: host.tenantId,
      registerId: { in: ['reg-active', 'reg-active-2'] },
      drawerReleasedAt: null,
    });
    // Names are loaded once, and only for the sessions that end up in heldBy.
    expect(usersMany).toHaveBeenCalledTimes(1);
    expect(asJson(asJson(usersMany.mock.calls[0][0]).where)).toEqual({
      id: { in: ['u1'] },
    });
  });

  it('skips the session and name lookups when no register is visible', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedRegister(host, 'reg-inactive', 'Caja Inactiva', false);
    const sessionsMany = jest.spyOn(tx.cashSession, 'findMany');
    const usersMany = jest.spyOn(tx.user, 'findMany');

    const doc = await queryRegisters(
      tx,
      host.tenantId,
      conditionalRegisterReader('u1'),
    );

    expect(asItems(doc.items)).toEqual([]);
    expect(sessionsMany).not.toHaveBeenCalled();
    expect(usersMany).not.toHaveBeenCalled();
  });
});
