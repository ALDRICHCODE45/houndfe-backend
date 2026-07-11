/**
 * Slice C.1 — NotificationConfigService tests.
 *
 * Covers the service layer's two responsibilities beyond port delegation
 * (mirrors `src/sat-catalog/sat-catalog.service.spec.ts` — pure unit, the
 * repository and the tenant prisma service are mocked; no DI container):
 *
 *   - `read()` delegates to `port.find()`.
 *   - `replace()`:
 *       1. Re-validates action keys against the locked v1 set and throws
 *          `BadRequestException({ error: 'UNKNOWN_ACTION_KEY' })` BEFORE
 *          delegating to `port.replace` (defense in depth — the adapter also
 *          validates, but the service owns the policy).
 *       2. **CRITICAL (carried from Slice B review-risk WARNING 1):** validates
 *          that every `recipientUserIds[i]` resolves to a `TenantMembership`
 *          row for the CURRENT tenant. `User` is a global identity model and
 *          `NotificationRecipient.userId` only enforces global existence, so
 *          without this check a tenant admin could register another tenant's
 *          userId as a notification recipient — cross-tenant targeting once
 *          emails fire in a later slice. Rejects both cross-tenant AND
 *          non-existent user IDs with
 *          `BadRequestException({ error: 'INVALID_RECIPIENT' })`.
 *
 * Spec: `openspec/changes/low-stock-alerts/specs/notification-config/spec.md`.
 */
import { BadRequestException } from '@nestjs/common';
import { NotificationConfigService } from './notification-config.service';
import type { INotificationConfigRepository } from './domain/notification-config.repository';
import type { NotificationActionKey } from './domain/notification-config';

function makePort(overrides: Partial<INotificationConfigRepository> = {}) {
  return {
    find: jest.fn(),
    replace: jest.fn(),
    ...overrides,
  } as jest.Mocked<INotificationConfigRepository>;
}

/**
 * Mock of `TenantPrismaService` that resolves "which user IDs are members of
 * the current tenant" via a fixed allowlist. Anything not in the allowlist is
 * treated as foreign / non-existent — exactly the production semantics, with
 * no live DB.
 */
function makeTenantPrismaMock(opts?: {
  tenantId?: string;
  memberUserIds?: string[];
}) {
  const tenantId = opts?.tenantId ?? 'tenant-1';
  const members = new Set(opts?.memberUserIds ?? []);

  const tenantMembership = {
    findMany: jest.fn().mockImplementation(({ where }: any) => {
      const requestedIds: string[] = (where?.userId?.in ?? []) as string[];
      return Promise.resolve(
        requestedIds
          .filter((id) => members.has(id))
          .map((userId) => ({ userId })),
      );
    }),
  };

  return {
    getTenantId: jest.fn().mockReturnValue(tenantId),
    getClient: jest.fn().mockReturnValue({ tenantMembership }),
  };
}

const baseView = {
  enabled: false,
  recipients: [],
  enabledActions: [] as NotificationActionKey[],
};

describe('NotificationConfigService.read (C.1)', () => {
  it('delegates to port.find and returns its result verbatim', async () => {
    const port = makePort({
      find: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: ['u1', 'u2'],
        enabledActions: ['LOW_STOCK'],
      }),
    });
    const svc = new NotificationConfigService(
      port,
      makeTenantPrismaMock() as any,
    );

    const view = await svc.read();

    expect(port.find).toHaveBeenCalledTimes(1);
    expect(view).toEqual({
      enabled: true,
      recipients: ['u1', 'u2'],
      enabledActions: ['LOW_STOCK'],
    });
  });

  it('returns the safe empty defaults when the port returns them', async () => {
    const port = makePort({
      find: jest.fn().mockResolvedValue({ ...baseView }),
    });
    const svc = new NotificationConfigService(
      port,
      makeTenantPrismaMock() as any,
    );

    expect(await svc.read()).toEqual({
      enabled: false,
      recipients: [],
      enabledActions: [],
    });
  });
});

describe('NotificationConfigService.replace — action-key policy (C.1)', () => {
  it('throws BadRequestException UNKNOWN_ACTION_KEY for a foreign key WITHOUT calling the port', async () => {
    const port = makePort();
    const tp = makeTenantPrismaMock();
    const svc = new NotificationConfigService(port, tp as any);

    // Cast bypasses TS literal narrowing — runtime must still reject.
    await expect(
      svc.replace({
        enabled: true,
        recipientUserIds: [],
        enabledActions: ['LEAD_CREATED' as unknown as NotificationActionKey],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(port.replace).not.toHaveBeenCalled();
    // Defense in depth: service-level validation runs BEFORE any DB read.
    expect(tp.getClient).not.toHaveBeenCalled();
  });

  it('triangulates: a mix of valid + invalid keys is rejected and writes nothing', async () => {
    const port = makePort();
    const tp = makeTenantPrismaMock();
    const svc = new NotificationConfigService(port, tp as any);

    await expect(
      svc.replace({
        enabled: true,
        recipientUserIds: [],
        enabledActions: [
          'LOW_STOCK',
          'WHATEVER',
        ] as unknown as NotificationActionKey[],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(port.replace).not.toHaveBeenCalled();
  });

  it('inspects the error payload to confirm error=UNKNOWN_ACTION_KEY', async () => {
    const port = makePort();
    const svc = new NotificationConfigService(
      port,
      makeTenantPrismaMock() as any,
    );

    try {
      await svc.replace({
        enabled: true,
        recipientUserIds: [],
        enabledActions: ['NOT_A_KEY' as unknown as NotificationActionKey],
      });
      fail('expected throw');
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

describe('NotificationConfigService.replace — recipient tenant-membership (C.1, CRITICAL)', () => {
  it('rejects a FOREIGN-TENANT userId with INVALID_RECIPIENT and does NOT call port.replace', async () => {
    // tenant-1 members: [u1]. userId uOther exists in the global User table
    // but is a member of tenant-2 only — so querying tenant_memberships for
    // (uOther, tenant-1) returns zero rows.
    const port = makePort();
    const tp = makeTenantPrismaMock({ memberUserIds: ['u1'] });
    const svc = new NotificationConfigService(port, tp as any);

    await expect(
      svc.replace({
        enabled: true,
        recipientUserIds: ['uOther'],
        enabledActions: ['LOW_STOCK'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Spec "no rows are written" — port MUST NOT be called.
    expect(port.replace).not.toHaveBeenCalled();
  });

  it('rejects a NON-EXISTENT userId with INVALID_RECIPIENT (no row in users / memberships)', async () => {
    const port = makePort();
    const tp = makeTenantPrismaMock({ memberUserIds: [] });
    const svc = new NotificationConfigService(port, tp as any);

    await expect(
      svc.replace({
        enabled: true,
        recipientUserIds: ['u-ghost'],
        enabledActions: ['LOW_STOCK'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(port.replace).not.toHaveBeenCalled();
  });

  it('triangulates: a list mixing valid + foreign recipients is REJECTED atomically', async () => {
    // Master ON, action ON, recipients [u1 (member of tenant-1), uForeign (member of tenant-2)].
    // Even ONE invalid recipient ⇒ the whole list is rejected, no rows written.
    const port = makePort();
    const tp = makeTenantPrismaMock({ memberUserIds: ['u1'] });
    const svc = new NotificationConfigService(port, tp as any);

    await expect(
      svc.replace({
        enabled: true,
        recipientUserIds: ['u1', 'uForeign'],
        enabledActions: ['LOW_STOCK'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(port.replace).not.toHaveBeenCalled();
  });

  it('inspects the error payload to confirm error=INVALID_RECIPIENT and lists the offending ids', async () => {
    const port = makePort();
    const tp = makeTenantPrismaMock({ memberUserIds: ['u1'] });
    const svc = new NotificationConfigService(port, tp as any);

    try {
      await svc.replace({
        enabled: true,
        recipientUserIds: ['u1', 'uForeign'],
        enabledActions: ['LOW_STOCK'],
      });
      fail('expected throw');
    } catch (err) {
      const resp = (err as BadRequestException).getResponse() as Record<
        string,
        unknown
      >;
      expect(resp.error).toBe('INVALID_RECIPIENT');
      expect(typeof resp.message).toBe('string');
      // The message must include the offending ids so the caller can correct them.
      expect(resp.message as string).toContain('uForeign');
    }
  });

  it('queries tenant_memberships with the CURRENT tenantId from CLS', async () => {
    const port = makePort({
      replace: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: ['u1'],
        enabledActions: ['LOW_STOCK'],
      }),
    });
    const tp = makeTenantPrismaMock({
      tenantId: 'tenant-9',
      memberUserIds: ['u1'],
    });
    const svc = new NotificationConfigService(port, tp as any);

    await svc.replace({
      enabled: true,
      recipientUserIds: ['u1'],
      enabledActions: ['LOW_STOCK'],
    });

    expect(tp.getTenantId).toHaveBeenCalled();
    const membershipFindCalls =
      tp.getClient.mock.results[0].value.tenantMembership.findMany.mock.calls;
    expect(membershipFindCalls).toHaveLength(1);
    expect(membershipFindCalls[0][0]).toEqual({
      where: {
        userId: { in: ['u1'] },
        tenantId: 'tenant-9',
      },
      select: { userId: true },
    });
    expect(port.replace).toHaveBeenCalledTimes(1);
  });

  it('passes an EMPTY recipient list without hitting the membership query (master ON, no recipients)', async () => {
    const port = makePort({
      replace: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: [],
        enabledActions: ['LOW_STOCK'],
      }),
    });
    const tp = makeTenantPrismaMock();
    const svc = new NotificationConfigService(port, tp as any);

    await svc.replace({
      enabled: true,
      recipientUserIds: [],
      enabledActions: ['LOW_STOCK'],
    });

    expect(tp.getClient).not.toHaveBeenCalled();
    expect(port.replace).toHaveBeenCalledTimes(1);
  });

  it('delegates to port.replace when ALL recipients are current-tenant members', async () => {
    const port = makePort({
      replace: jest.fn().mockResolvedValue({
        enabled: true,
        recipients: ['u1', 'u2'],
        enabledActions: ['LOW_STOCK'],
      }),
    });
    const tp = makeTenantPrismaMock({ memberUserIds: ['u1', 'u2', 'u3'] });
    const svc = new NotificationConfigService(port, tp as any);

    const view = await svc.replace({
      enabled: true,
      recipientUserIds: ['u1', 'u2'],
      enabledActions: ['LOW_STOCK'],
    });

    expect(port.replace).toHaveBeenCalledWith({
      enabled: true,
      recipientUserIds: ['u1', 'u2'],
      enabledActions: ['LOW_STOCK'],
    });
    expect(view).toEqual({
      enabled: true,
      recipients: ['u1', 'u2'],
      enabledActions: ['LOW_STOCK'],
    });
  });

  it('runs UNKNOWN_ACTION_KEY check BEFORE recipient validation (action keys are cheaper to fail-fast on)', async () => {
    const port = makePort();
    const tp = makeTenantPrismaMock({ memberUserIds: [] });
    const svc = new NotificationConfigService(port, tp as any);

    // Both keys invalid AND all recipients invalid → must surface
    // UNKNOWN_ACTION_KEY (first gate), and must NOT query the DB at all.
    await expect(
      svc.replace({
        enabled: true,
        recipientUserIds: ['u-ghost'],
        enabledActions: ['BAD_KEY' as unknown as NotificationActionKey],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    try {
      await svc.replace({
        enabled: true,
        recipientUserIds: ['u-ghost'],
        enabledActions: ['BAD_KEY' as unknown as NotificationActionKey],
      });
    } catch (err) {
      const resp = (err as BadRequestException).getResponse() as Record<
        string,
        unknown
      >;
      expect(resp.error).toBe('UNKNOWN_ACTION_KEY');
    }

    expect(tp.getClient).not.toHaveBeenCalled();
    expect(port.replace).not.toHaveBeenCalled();
  });
});
