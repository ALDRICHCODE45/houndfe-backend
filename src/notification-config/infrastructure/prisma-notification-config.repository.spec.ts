/**
 * Slice B.2 — PrismaNotificationConfigRepository adapter tests.
 * Mirrors `src/products/infrastructure/prisma-product.repository.spec.ts`:
 * structural mock for the tenant-scoped client, no live DB.
 *
 * Covers spec scenarios in
 * `openspec/changes/low-stock-alerts/specs/notification-config/spec.md`:
 * find() empty defaults / populated / no manual tenantId (A.1);
 * replace() full overwrite / unknown action key.
 */
import { BadRequestException } from '@nestjs/common';
import { PrismaNotificationConfigRepository } from './prisma-notification-config.repository';
import type { NotificationActionKey } from '../domain/notification-config';

function makeTenantPrismaMock(overrides: Record<string, any> = {}) {
  const client = {
    notificationSettings: { findFirst: jest.fn(), upsert: jest.fn() },
    notificationRecipient: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    notificationAction: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    $transaction: jest.fn(),
    ...overrides,
  } as any;
  client.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === 'function' ? arg(client) : Promise.all(arg),
  );
  return {
    getClient: jest.fn().mockReturnValue(client),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
    client,
  };
}

const makeRepo = (tp: any) => new PrismaNotificationConfigRepository(tp);
const blankRow = () => ({ count: 0 });
const okRow = () => ({ enabled: true });

describe('PrismaNotificationConfigRepository.find (B.2)', () => {
  it('returns safe empty defaults when there is no NotificationSettings row', async () => {
    const tp = makeTenantPrismaMock();
    tp.client.notificationSettings.findFirst.mockResolvedValue(null);
    expect(await makeRepo(tp).find()).toEqual({
      enabled: false,
      recipients: [],
      enabledActions: [],
    });
    expect(tp.client.notificationRecipient.findMany).not.toHaveBeenCalled();
    expect(tp.client.notificationAction.findMany).not.toHaveBeenCalled();
  });

  it('returns the persisted view verbatim when all 3 tables are populated', async () => {
    const tp = makeTenantPrismaMock();
    tp.client.notificationSettings.findFirst.mockResolvedValue({
      enabled: true,
    });
    tp.client.notificationRecipient.findMany.mockResolvedValue([
      { userId: 'u1' },
      { userId: 'u2' },
    ]);
    tp.client.notificationAction.findMany.mockResolvedValue([
      { action: 'LOW_STOCK' },
    ]);
    expect(await makeRepo(tp).find()).toEqual({
      enabled: true,
      recipients: ['u1', 'u2'],
      enabledActions: ['LOW_STOCK'],
    });
  });

  it('queries the tenant-scoped client WITHOUT manually passing tenantId (A.1)', async () => {
    const tp = makeTenantPrismaMock();
    tp.client.notificationSettings.findFirst.mockResolvedValue({
      enabled: true,
    });
    tp.client.notificationRecipient.findMany.mockResolvedValue([]);
    tp.client.notificationAction.findMany.mockResolvedValue([]);
    await makeRepo(tp).find();
    const s = tp.client.notificationSettings.findFirst.mock.calls[0][0];
    const r = tp.client.notificationRecipient.findMany.mock.calls[0][0];
    const a = tp.client.notificationAction.findMany.mock.calls[0][0];
    expect(s?.where).toBeUndefined();
    expect(r?.where?.tenantId).toBeUndefined();
    expect(a?.where?.tenantId).toBeUndefined();
  });
});

describe('PrismaNotificationConfigRepository.replace (B.2)', () => {
  it('upserts settings, replaces recipients, replaces actions — all in one tx', async () => {
    const tp = makeTenantPrismaMock();
    tp.client.notificationSettings.upsert.mockResolvedValue({});
    tp.client.notificationRecipient.deleteMany.mockResolvedValue({ count: 1 });
    tp.client.notificationRecipient.createMany.mockResolvedValue({ count: 3 });
    tp.client.notificationAction.deleteMany.mockResolvedValue({ count: 1 });
    tp.client.notificationAction.createMany.mockResolvedValue({ count: 0 });
    tp.client.notificationSettings.findFirst.mockResolvedValue({
      enabled: false,
    });
    tp.client.notificationRecipient.findMany.mockResolvedValue([
      { userId: 'u2' },
      { userId: 'u3' },
      { userId: 'u4' },
    ]);
    tp.client.notificationAction.findMany.mockResolvedValue([]);

    const view = await makeRepo(tp).replace({
      enabled: false,
      recipientUserIds: ['u2', 'u3', 'u4'],
      enabledActions: [],
    });

    expect(tp.client.$transaction).toHaveBeenCalledTimes(1);
    expect(tp.client.notificationSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { enabled: false },
        create: expect.objectContaining({ enabled: false }),
      }),
    );
    expect(tp.client.notificationRecipient.deleteMany).toHaveBeenCalled();
    expect(tp.client.notificationRecipient.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ userId: 'u2' }),
          expect.objectContaining({ userId: 'u3' }),
          expect.objectContaining({ userId: 'u4' }),
        ]),
      }),
    );
    expect(tp.client.notificationAction.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [] }),
    );
    expect(view).toEqual({
      enabled: false,
      recipients: ['u2', 'u3', 'u4'],
      enabledActions: [],
    });
  });

  it('upsert `where` carries no manual tenantId — extension injects it (A.1)', async () => {
    const tp = makeTenantPrismaMock();
    tp.client.notificationSettings.upsert.mockResolvedValue({});
    tp.client.notificationRecipient.deleteMany.mockResolvedValue(blankRow());
    tp.client.notificationRecipient.createMany.mockResolvedValue(blankRow());
    tp.client.notificationAction.deleteMany.mockResolvedValue(blankRow());
    tp.client.notificationAction.createMany.mockResolvedValue(blankRow());
    tp.client.notificationSettings.findFirst.mockResolvedValue(okRow());
    tp.client.notificationRecipient.findMany.mockResolvedValue([]);
    tp.client.notificationAction.findMany.mockResolvedValue([]);

    await makeRepo(tp).replace({
      enabled: true,
      recipientUserIds: [],
      enabledActions: ['LOW_STOCK'],
    });

    const upsertArgs = tp.client.notificationSettings.upsert.mock.calls[0][0];
    expect(upsertArgs.where.tenantId).toBe('__CLS_RESOLVES__');
    expect(upsertArgs.create.tenantId).toBeUndefined();
    expect(upsertArgs.update.tenantId).toBeUndefined();
  });

  it('throws BadRequestException UNKNOWN_ACTION_KEY when any key is outside v1 — and writes nothing', async () => {
    const tp = makeTenantPrismaMock();
    // Cast bypasses TS literal-type narrowing on `NotificationActionKey`
    // ('LOW_STOCK' only); the RUNTIME must still reject 'LEAD_CREATED'.
    const rejectUnknown = [
      'LEAD_CREATED',
      'WHATEVER',
    ] as unknown as NotificationActionKey[];

    for (const enabledActions of [
      rejectUnknown,
      ['LOW_STOCK', ...rejectUnknown] as unknown as NotificationActionKey[],
    ]) {
      await expect(
        makeRepo(tp).replace({
          enabled: true,
          recipientUserIds: [],
          enabledActions,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }

    // Spec "no rows are written": validation runs BEFORE the tx.
    expect(tp.client.$transaction).not.toHaveBeenCalled();
    expect(tp.client.notificationSettings.upsert).not.toHaveBeenCalled();
    expect(tp.client.notificationRecipient.deleteMany).not.toHaveBeenCalled();
    expect(tp.client.notificationRecipient.createMany).not.toHaveBeenCalled();
    expect(tp.client.notificationAction.deleteMany).not.toHaveBeenCalled();
    expect(tp.client.notificationAction.createMany).not.toHaveBeenCalled();

    // Inspect the error payload once.
    try {
      await makeRepo(tp).replace({
        enabled: true,
        recipientUserIds: ['u1'],
        enabledActions: ['LEAD_CREATED' as unknown as NotificationActionKey],
      });
    } catch (err) {
      const resp = (err as BadRequestException).getResponse() as Record<
        string,
        unknown
      >;
      expect(resp.error).toBe('UNKNOWN_ACTION_KEY');
      expect(typeof resp.message).toBe('string');
    }
  });
});
