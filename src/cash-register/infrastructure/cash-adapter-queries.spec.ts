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
});
