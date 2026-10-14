/**
 * cash-register-closing / G1 (S1, S4) — blind required-channel discovery.
 *
 * The frontend needs every channel identity a blind count must declare even
 * though a frozen pre-submission detail hides `channelSnapshot` and
 * `movements`. This regression drives the PUBLIC `ICashApplication` query
 * (`GET /cash-sessions/:id` via `app.query({ kind: 'SESSION' })`) and pins the
 * additive, identity-only `requiredChannels` discovery projection:
 *
 *   - derived from the FROZEN expected snapshot (never a current payment
 *     catalog), so a renamed/removed catalog row cannot change history;
 *   - the same frozen identities `DECLARE` accepts as `requiredChannelKeys`,
 *     always including the pooled `CASH` channel;
 *   - identity only (`channelKey` / `channelLabel` / `method`), with no
 *     expected amounts, differences, movement metadata or activity counts;
 *   - present ONLY for the declarant's own frozen blind window, never before
 *     the freeze and never once expected values are revealed;
 *   - gated by the SAME tenant/owner/audit/conditional checks as the detail.
 *
 * Unit mocks over the shared in-memory fake do not prove PostgreSQL behavior.
 */
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { randomUUID } from 'crypto';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import type { CashActor } from '../cash-application.port';
import type { PrismaCashRegisterApplication } from './prisma-cash-register';
import {
  actor,
  asItems,
  asJson,
  makeApp,
  seedActors,
} from './prisma-cash-register.test-support';
import type { Host } from './prisma-cash-register.test-support';

// ── Fixtures ────────────────────────────────────────────────────────────

interface ConditionalRule {
  action: AppActions;
  subject: AppSubjects;
  conditions?: Record<string, unknown>;
}

function conditionalActor(
  userId: string,
  rules: readonly ConditionalRule[],
): CashActor {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const rule of rules) {
    if (rule.conditions) {
      can(rule.action, rule.subject, rule.conditions);
    } else {
      can(rule.action, rule.subject);
    }
  }
  return { userId, ability: build() };
}

async function openSession(
  app: PrismaCashRegisterApplication,
  host: Host,
  openingCents = 1000,
): Promise<string> {
  seedActors(host, ['u1', 'u2', 'u3']);
  const register = asJson(
    await app.execute(
      actor('u1'),
      { kind: 'CREATE_REGISTER', name: `Caja ${randomUUID()}` },
      randomUUID(),
    ),
  );
  const opened = asJson(
    await app.execute(
      actor('u1'),
      {
        kind: 'OPEN_SESSION',
        registerId: register.id as string,
        openingCents,
        openingConfirmed: true,
      },
      randomUUID(),
    ),
  );
  return asJson(opened.session).id as string;
}

function seedMovement(
  host: Host,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): void {
  host.db.movements.push({
    id: randomUUID(),
    tenantId: host.tenantId,
    sessionId,
    kind: 'SALE_PAYMENT',
    deltaCents: 5000,
    method: 'CARD_CREDIT',
    channelKey: 'PM:pm-1',
    channelLabel: 'Tarjeta Legacy',
    sourceType: 'PAYMENT',
    sourceId: randomUUID(),
    actorUserId: 'u1',
    reason: null,
    occurredAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  });
}

async function freeze(
  app: PrismaCashRegisterApplication,
  sessionId: string,
): Promise<void> {
  await app.execute(
    actor('u1'),
    { kind: 'START_COUNT', sessionId },
    randomUUID(),
  );
}

function querySessionDetail(
  app: PrismaCashRegisterApplication,
  userId: string,
  sessionId: string,
  cashActor: CashActor = actor(userId),
): Promise<Record<string, unknown>> {
  return app
    .query(cashActor, { kind: 'SESSION', id: sessionId })
    .then((doc) => asJson(doc));
}

// ── S1 discovery projection ─────────────────────────────────────────────

describe('cash count discovery — frozen blind session (S1)', () => {
  it('exposes the frozen channel identities after the payment catalog changed', async () => {
    const { app, host } = makeApp();
    const sessionId = await openSession(app, host, 1000);
    // The label is the identity captured at operation time. There is no
    // current payment catalog read anywhere in this flow, so a later rename
    // or a removed catalog row cannot rewrite the required identity.
    seedMovement(host, sessionId);
    await freeze(app, sessionId);

    const doc = await querySessionDetail(app, 'u1', sessionId);

    expect(doc.requiredChannels).toEqual([
      { channelKey: 'CASH', channelLabel: 'Efectivo', method: 'CASH' },
      {
        channelKey: 'PM:pm-1',
        channelLabel: 'Tarjeta Legacy',
        method: 'CARD_CREDIT',
      },
    ]);
    expect(asJson(doc.session).blind).toBe(true);
    expect(doc.channelSnapshot).toBeNull();
    expect(doc.movements).toEqual([]);
  });

  it('returns the pooled cash channel for a zero-activity drawer', async () => {
    const { app, host } = makeApp();
    const sessionId = await openSession(app, host, 2500);
    await freeze(app, sessionId);

    const doc = await querySessionDetail(app, 'u1', sessionId);

    expect(doc.requiredChannels).toEqual([
      { channelKey: 'CASH', channelLabel: 'Efectivo', method: 'CASH' },
    ]);
  });

  it('reloads a deterministic, ordered identity list', async () => {
    const { app, host } = makeApp();
    const sessionId = await openSession(app, host, 0);
    seedMovement(host, sessionId, {
      channelKey: 'PM:zz',
      channelLabel: 'Zeta',
      method: 'CARD_DEBIT',
    });
    seedMovement(host, sessionId, {
      channelKey: 'PM:aa',
      channelLabel: 'Alfa',
      method: 'TRANSFER',
    });
    await freeze(app, sessionId);

    const first = await querySessionDetail(app, 'u1', sessionId);
    const second = await querySessionDetail(app, 'u1', sessionId);

    expect(first.requiredChannels).toEqual([
      { channelKey: 'CASH', channelLabel: 'Efectivo', method: 'CASH' },
      { channelKey: 'PM:aa', channelLabel: 'Alfa', method: 'TRANSFER' },
      { channelKey: 'PM:zz', channelLabel: 'Zeta', method: 'CARD_DEBIT' },
    ]);
    expect(JSON.stringify(second.requiredChannels)).toBe(
      JSON.stringify(first.requiredChannels),
    );
  });

  it('discloses identities without amounts or movement metadata', async () => {
    const { app, host } = makeApp();
    const sessionId = await openSession(app, host, 1000);
    seedMovement(host, sessionId);
    await freeze(app, sessionId);

    const doc = await querySessionDetail(app, 'u1', sessionId);

    const channels = asItems(doc.requiredChannels);
    expect(channels).toHaveLength(2);
    for (const channel of channels) {
      expect(Object.keys(channel).sort()).toEqual([
        'channelKey',
        'channelLabel',
        'method',
      ]);
      expect(channel.expectedCents).toBeUndefined();
    }
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain('expectedCents');
    expect(serialized).not.toContain('deltaCents');
    expect(asJson(doc.session).expectedCashCents).toBeUndefined();
    expect(asJson(doc.session).differenceCents).toBeUndefined();
    expect(doc.channelSnapshot).toBeNull();
    expect(doc.movements).toEqual([]);
    expect(doc.counts).toEqual([]);
    expect(doc.handovers).toEqual([]);
  });
});

// ── S1/S4 authorization boundaries ──────────────────────────────────────

describe('cash count discovery — authorization boundaries (S1, S4)', () => {
  it('denies another cashier without audit visibility', async () => {
    const { app, host } = makeApp();
    const sessionId = await openSession(app, host);
    await freeze(app, sessionId);

    await expect(
      app.query(actor('u2', [['read', 'CashSession']]), {
        kind: 'SESSION',
        id: sessionId,
      }),
    ).rejects.toMatchObject({ code: 'CASH_PERMISSION_DENIED' });
  });

  it('denies an owner whose conditional read excludes the frozen status', async () => {
    const { app, host } = makeApp();
    const sessionId = await openSession(app, host);
    await freeze(app, sessionId);

    const owner = conditionalActor('u1', [
      {
        action: 'read',
        subject: 'CashSession',
        conditions: { status: 'OPEN' },
      },
    ]);

    await expect(
      app.query(owner, { kind: 'SESSION', id: sessionId }),
    ).rejects.toMatchObject({ code: 'CASH_PERMISSION_DENIED' });
  });

  it('fails closed on a cross-tenant session id', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1']);
    host.db.sessions.push({
      id: 's-foreign',
      tenantId: 'tenant-b',
      registerId: 'reg-foreign',
      cashierUserId: 'u1',
      openingCents: 0,
      status: 'COUNTING',
      openedAt: new Date(),
      frozenAt: new Date(),
      submittedAt: null,
      closedAt: null,
      drawerReleasedAt: null,
      openingHandoverId: null,
      expectedJson: {
        cashExpectedCents: 0,
        frozenAt: new Date().toISOString(),
        channels: [
          {
            channelKey: 'CASH',
            channelLabel: 'Efectivo',
            method: 'CASH',
            expectedCents: 0,
          },
        ],
      },
    });

    await expect(
      app.query(actor('u1'), { kind: 'SESSION', id: 's-foreign' }),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_FOUND' });
  });
});

// ── Preserved existing projections ──────────────────────────────────────

describe('cash count discovery — preserved existing projections (S4)', () => {
  it('keeps the pre-freeze blind OPEN projection unchanged', async () => {
    const { app, host } = makeApp();
    const sessionId = await openSession(app, host, 1000);
    seedMovement(host, sessionId);

    const doc = await querySessionDetail(app, 'u1', sessionId);

    expect(asJson(doc.session).blind).toBe(true);
    expect(doc.requiredChannels).toBeUndefined();
    expect(doc.channelSnapshot).toBeNull();
    expect(doc.movements).toEqual([]);
    expect(asJson(doc.session).expectedCashCents).toBeUndefined();
  });

  it('keeps the visible SUBMITTED projection and reveals the snapshot', async () => {
    const { app, host } = makeApp();
    const sessionId = await openSession(app, host, 1000);
    seedMovement(host, sessionId);
    await freeze(app, sessionId);
    await app.execute(
      actor('u1'),
      {
        kind: 'DECLARE',
        sessionId,
        lines: [
          { channelKey: 'CASH', amountCents: 1000 },
          { channelKey: 'PM:pm-1', amountCents: 5000 },
        ],
      },
      randomUUID(),
    );

    const doc = await querySessionDetail(app, 'u1', sessionId);

    expect(asJson(doc.session).blind).toBe(false);
    // The catalog identities are already exposed as channelSnapshot once the
    // declaration is submitted, so the additive discovery field is omitted.
    expect(doc.requiredChannels).toBeUndefined();
    expect(asItems(doc.channelSnapshot)).toHaveLength(2);
    expect(asItems(doc.movements)).toHaveLength(1);
    expect(asItems(doc.counts)).toHaveLength(1);
    expect(asJson(doc.session).expectedCashCents).toBe(1000);
  });
});
