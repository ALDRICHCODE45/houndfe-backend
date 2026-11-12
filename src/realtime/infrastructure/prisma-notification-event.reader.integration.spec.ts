/**
 * human-intervention / unit 8 — the batched notification reads of the realtime
 * shaper against REAL PostgreSQL: same notice (shape and text) and same unread
 * count as the REST service, ownership enforced, tenants isolated, and a fixed
 * number of statements whatever the batch size.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { integrationPrisma } from '../../../test/integration/reset-db';
import { NotificationsService } from '../../notifications/application/notifications.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PrismaNotificationEventReader } from './prisma-notification-event.reader';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

describeIfDb('PrismaNotificationEventReader (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );
  const tenantPrisma = new TenantPrismaService(
    prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
    cls,
  );
  const reader = new PrismaNotificationEventReader(tenantPrisma);
  const service = new NotificationsService(
    tenantPrisma,
    prisma as unknown as PrismaService,
  );

  const tenants: string[] = [];
  const users: string[] = [];
  let tenantId: string;
  let otherTenantId: string;
  let ana: string;
  let luis: string;

  const inTenant = <T>(tenant: string, work: () => Promise<T>) =>
    cls.runWith(
      { tenantId: tenant, userId: 'test', isSuperAdmin: false },
      work,
    );

  const notice = async (
    tenant: string,
    userId: string,
    over: { readAt?: Date | null; type?: string } = {},
  ) => {
    const row = await prisma.notification.create({
      data: {
        tenantId: tenant,
        userId,
        type: over.type ?? 'REQUEST_CREATED',
        payload: { folio: 7, subtype: 'UNKNOWN_QUESTION' },
        dedupKey: randomUUID(),
        readAt: over.readAt ?? null,
      },
      select: { id: true },
    });
    return row.id;
  };

  beforeEach(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    for (const id of [tenantId, otherTenantId]) {
      tenants.push(id);
      await prisma.tenant.create({
        data: { id, name: 'Sucursal NR', slug: `ner-${id}` },
      });
    }
    ana = randomUUID();
    luis = randomUUID();
    for (const [name, id] of [
      ['ana', ana],
      ['luis', luis],
    ]) {
      users.push(id);
      await prisma.user.create({
        data: {
          id,
          email: `${name}-${id}@ner.test`,
          hashedPassword: 'x',
          name,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('returns the same notice and unread count as the REST service', async () => {
    const id = await notice(tenantId, ana);
    await notice(tenantId, ana);
    await notice(tenantId, ana, { readAt: new Date() });
    const { viaReader, viaService, counts, count } = await inTenant(
      tenantId,
      async () => ({
        viaReader: (await reader.views([{ userId: ana, id }])).get(id),
        viaService: (await service.eventView(ana, id))?.notification,
        counts: await reader.unreadCounts([ana]),
        count: (await service.unreadCount(ana)).count,
      }),
    );
    expect(viaReader).toBeDefined();
    expect(viaReader).toEqual(viaService);
    expect(counts.get(ana)).toBe(2);
    expect(counts.get(ana)).toBe(count);
  });

  it('a user with nothing unread maps to 0, and only asked users appear', async () => {
    await notice(tenantId, ana);
    const counts = await inTenant(tenantId, () =>
      reader.unreadCounts([ana, luis]),
    );
    expect([...counts.entries()].sort()).toEqual(
      [
        [ana, 1],
        [luis, 0],
      ].sort(),
    );
  });

  it("never returns someone else's notice, or another tenant's", async () => {
    const mine = await notice(tenantId, ana);
    const luisOwn = await notice(tenantId, luis);
    const foreign = await notice(otherTenantId, ana);
    const views = await inTenant(tenantId, () =>
      reader.views([
        { userId: ana, id: mine },
        { userId: ana, id: luisOwn }, // luis's notice asked for as ana
        { userId: ana, id: foreign }, // another tenant's
        { userId: ana, id: randomUUID() }, // purged / unknown
      ]),
    );
    expect([...views.keys()]).toEqual([mine]);
    const counts = await inTenant(tenantId, () => reader.unreadCounts([ana]));
    expect(counts.get(ana)).toBe(1);
  });

  it('is one statement per read however many users and notices', async () => {
    const wanted: Array<{ userId: string; id: string }> = [];
    for (let i = 0; i < 15; i += 1) {
      wanted.push({ userId: i % 2 ? ana : luis, id: '' });
      wanted[i].id = await notice(tenantId, wanted[i].userId);
    }
    const queries: string[] = [];
    const original = tenantPrisma.getClient.bind(tenantPrisma) as () => unknown;
    const spy = jest.spyOn(tenantPrisma, 'getClient');
    spy.mockImplementation(() => {
      queries.push('getClient');
      return original() as ReturnType<typeof tenantPrisma.getClient>;
    });
    try {
      await inTenant(tenantId, async () => {
        await reader.views(wanted);
        await reader.unreadCounts([ana, luis]);
      });
    } finally {
      spy.mockRestore();
    }
    // One client use per read: one findMany, one groupBy.
    expect(queries).toHaveLength(2);
  });

  it('empty input costs nothing', async () => {
    const spy = jest.spyOn(tenantPrisma, 'getClient');
    try {
      await inTenant(tenantId, async () => {
        expect((await reader.views([])).size).toBe(0);
        expect((await reader.unreadCounts([])).size).toBe(0);
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
