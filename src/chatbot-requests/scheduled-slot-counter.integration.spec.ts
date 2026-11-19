/**
 * human-intervention / unit 14 — the per-block capacity counter against REAL
 * PostgreSQL (contract §4.9, §10 row 14 risk: "calcular el cupo con
 * concurrencia"). Parallel bookings for the last seat: exactly one wins; a
 * release gives the seat back; a move never deadlocks with the opposite move;
 * a full block is what the listing's range read returns.
 */
import { randomUUID } from 'crypto';
import { integrationPrisma } from '../../test/integration/reset-db';
import {
  moveSeat,
  readFullBlocks,
  releaseSeat,
  reserveSeat,
} from './infrastructure/scheduling-store';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const at = (v: string) => new Date(v);

describeIfDb('scheduled slot counter (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  let tenantId: string;
  let otherTenantId: string;

  const booked = async (tenant: string, startsAt: Date) =>
    (
      await prisma.scheduledSlotCounter.findUnique({
        where: { tenantId_startsAt: { tenantId: tenant, startsAt } },
      })
    )?.booked ?? 0;

  beforeAll(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    for (const id of [tenantId, otherTenantId]) {
      await prisma.tenant.create({
        data: { id, name: 'Sucursal agenda', slug: `slot-${id}` },
      });
    }
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await prisma.$disconnect();
  });

  it('parallel bookings for the last seat: exactly one wins, the counter never passes the limit', async () => {
    const startsAt = at('2026-11-10T15:00:00Z');
    expect(await reserveSeat(prisma, tenantId, startsAt, 3)).toBe(true);
    expect(await reserveSeat(prisma, tenantId, startsAt, 3)).toBe(true);
    // Two seats are taken; 12 callers race for the last one.
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        prisma.$transaction((tx) => reserveSeat(tx, tenantId, startsAt, 3)),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await booked(tenantId, startsAt)).toBe(3);
  });

  it('racing on a block that has no row yet creates it once and fills it to the limit', async () => {
    const startsAt = at('2026-11-10T15:30:00Z');
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        prisma.$transaction((tx) => reserveSeat(tx, tenantId, startsAt, 2)),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await booked(tenantId, startsAt)).toBe(2);
  });

  it('a release gives the seat back, never below zero, and only for that tenant', async () => {
    const startsAt = at('2026-11-10T16:00:00Z');
    await reserveSeat(prisma, tenantId, startsAt, 1);
    await reserveSeat(prisma, otherTenantId, startsAt, 1);
    expect(await reserveSeat(prisma, tenantId, startsAt, 1)).toBe(false);
    await releaseSeat(prisma, tenantId, startsAt);
    await releaseSeat(prisma, tenantId, startsAt);
    expect(await booked(tenantId, startsAt)).toBe(0);
    expect(await booked(otherTenantId, startsAt)).toBe(1);
    expect(await reserveSeat(prisma, tenantId, startsAt, 1)).toBe(true);
  });

  it('lowering the limit never evicts: a block over the new limit is simply full', async () => {
    const startsAt = at('2026-11-10T16:30:00Z');
    await reserveSeat(prisma, tenantId, startsAt, 3);
    await reserveSeat(prisma, tenantId, startsAt, 3);
    expect(await reserveSeat(prisma, tenantId, startsAt, 1)).toBe(false);
    expect(await booked(tenantId, startsAt)).toBe(2);
  });

  it('opposite moves at the same time finish without a deadlock and conserve the seats', async () => {
    const a = at('2026-11-11T15:00:00Z');
    const b = at('2026-11-11T15:30:00Z');
    await reserveSeat(prisma, tenantId, a, 5);
    await reserveSeat(prisma, tenantId, b, 5);
    const rounds = 15;
    for (let round = 0; round < rounds; round++) {
      await Promise.all([
        prisma.$transaction((tx) => moveSeat(tx, tenantId, a, b, 5)),
        prisma.$transaction((tx) => moveSeat(tx, tenantId, b, a, 5)),
      ]);
    }
    expect((await booked(tenantId, a)) + (await booked(tenantId, b))).toBe(2);
  });

  it('a move into a full block reports false (the caller rolls back)', async () => {
    const from = at('2026-11-12T15:00:00Z');
    const to = at('2026-11-12T15:30:00Z');
    await reserveSeat(prisma, tenantId, from, 2);
    await reserveSeat(prisma, tenantId, to, 1);
    await expect(
      prisma.$transaction(async (tx) => {
        const moved = await moveSeat(tx, tenantId, from, to, 1);
        if (!moved) throw new Error('full');
      }),
    ).rejects.toThrow('full');
    expect(await booked(tenantId, from)).toBe(1);
    expect(await booked(tenantId, to)).toBe(1);
  });

  it('readFullBlocks returns only the full blocks of the range, for the tenant', async () => {
    const full = at('2026-11-20T15:00:00Z');
    const free = at('2026-11-20T15:30:00Z');
    const outside = at('2026-11-25T15:00:00Z');
    await reserveSeat(prisma, tenantId, full, 1);
    await reserveSeat(prisma, tenantId, outside, 1);
    await reserveSeat(prisma, tenantId, free, 2);
    await releaseSeat(prisma, tenantId, free);
    await reserveSeat(prisma, otherTenantId, free, 1);
    const found = await readFullBlocks(
      prisma,
      tenantId,
      at('2026-11-20T00:00:00Z'),
      at('2026-11-21T00:00:00Z'),
      1,
    );
    expect([...found]).toEqual([full.getTime()]);
  });
});
