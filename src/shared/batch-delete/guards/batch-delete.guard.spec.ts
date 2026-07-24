/**
 * BatchDeleteGuard — strict TDD unit spec.
 *
 * Spec: batch-delete/spec.md R9 (Guard enforcement) + R10
 * (manage isolation). CASL's `manage` implies every action, so a
 * normal `PermissionsGuard` check on `ability.can('batch_delete', X)`
 * would wrongly allow users with `manage` only. This guard checks the
 * EFFECTIVE PERMISSIONS (raw DB rows) for an explicit
 * `batch_delete:<subject>` tuple.
 */
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  BatchDeleteGuard,
  BATCH_DELETE_GUARD_METADATA,
} from './batch-delete.guard';
import { InsufficientPermissionsError } from '../../domain/domain-error';
import type { CaslAbilityFactory, EffectivePermission } from '../../../casl-ability.factory';
import type { AuthenticatedUser } from '../../../../auth/interfaces/jwt-payload.interface';

function makeCtx(
  metadata: Array<[string, string]> | undefined,
  user: AuthenticatedUser | undefined,
): ExecutionContext {
  const handler = function named() {};
  const cls = class NamedCls {};
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key: string) =>
      key === BATCH_DELETE_GUARD_METADATA ? metadata : undefined,
    );

  const guard = new BatchDeleteGuard(
    reflector,
    {} as CaslAbilityFactory,
  );

  const ctx = {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;

  return Object.assign(ctx, { guard, reflector });
}

function userWith(
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser {
  return {
    userId: 'u-1',
    email: 'u@example.com',
    tenantId: 't-1',
    tenantSlug: 'tenant',
    isSuperAdmin: false,
    ...overrides,
  };
}

function makeGuardWithCasl(opts: {
  explicit: EffectivePermission[] | null;
}): BatchDeleteGuard {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockReturnValue([['batch_delete', 'Promotion']]);
  const casl = {
    getEffectivePermissions: jest.fn().mockResolvedValue(opts.explicit),
  } as unknown as CaslAbilityFactory;
  return new BatchDeleteGuard(reflector, casl);
}

describe('BatchDeleteGuard', () => {
  it('throws when there is no authenticated user', async () => {
    const ctx = makeCtx([['batch_delete', 'Promotion']], undefined);
    await expect(ctx.guard.canActivate(ctx)).rejects.toBeInstanceOf(
      Error,
    );
  });

  it('allows a user with explicit batch_delete:<subject>', async () => {
    const guard = makeGuardWithCasl({
      explicit: [{ action: 'batch_delete', subject: 'Promotion' }],
    });
    const ctx = makeCtx(
      [['batch_delete', 'Promotion']],
      userWith(),
    );
    // swap the guard in (ctx.guard uses a no-casl impl)
    Object.defineProperty(ctx, 'guard', { value: guard });
    jest
      .spyOn(Reflector.prototype, 'getAllAndOverride')
      .mockReturnValue([['batch_delete', 'Promotion']]);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects a user with only delete:<subject> (no batch_delete)', async () => {
    const guard = makeGuardWithCasl({
      explicit: [{ action: 'delete', subject: 'Promotion' }],
    });
    const ctx = makeCtx(
      [['batch_delete', 'Promotion']],
      userWith(),
    );

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      InsufficientPermissionsError,
    );
  });

  it('rejects a user with only manage:<subject> (R10 — manage does NOT imply batch_delete)', async () => {
    const guard = makeGuardWithCasl({
      explicit: [{ action: 'manage', subject: 'Promotion' }],
    });
    const ctx = makeCtx(
      [['batch_delete', 'Promotion']],
      userWith(),
    );

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      InsufficientPermissionsError,
    );
  });

  it('allows a superadmin without any explicit batch_delete row', async () => {
    const guard = makeGuardWithCasl({
      // getEffectivePermissions returns [{ manage, 'all' }] for superadmin
      explicit: [{ action: 'manage', subject: 'all' }],
    });
    const ctx = makeCtx(
      [['batch_delete', 'Promotion']],
      userWith({ isSuperAdmin: true, tenantId: null }),
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects an empty permissions list (no rows at all)', async () => {
    const guard = makeGuardWithCasl({ explicit: [] });
    const ctx = makeCtx(
      [['batch_delete', 'Promotion']],
      userWith(),
    );

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      InsufficientPermissionsError,
    );
  });

  it('treats a null effective-permissions result as "user not found" → 403', async () => {
    const guard = makeGuardWithCasl({ explicit: null });
    const ctx = makeCtx(
      [['batch_delete', 'Promotion']],
      userWith(),
    );

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      InsufficientPermissionsError,
    );
  });

  it('allows when no metadata is set on the route (route is unprotected)', async () => {
    // No metadata → guard is a no-op allow.
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(undefined);
    const casl = {
      getEffectivePermissions: jest.fn(),
    } as unknown as CaslAbilityFactory;
    const guard = new BatchDeleteGuard(reflector, casl);
    const ctx = makeCtx(undefined, userWith());

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(
      (casl.getEffectivePermissions as jest.Mock),
    ).not.toHaveBeenCalled();
  });

  it('only the batch_delete entries in metadata are evaluated; other entries are ignored', async () => {
    // Even if the route declares extra permission tuples that are not
    // batch_delete, this guard's job is solely to enforce the
    // explicit batch_delete:<subject> check. The standard
    // PermissionsGuard handles the other tuples elsewhere.
    const guard = makeGuardWithCasl({
      explicit: [{ action: 'batch_delete', subject: 'Promotion' }],
    });
    jest
      .spyOn(Reflector.prototype, 'getAllAndOverride')
      .mockReturnValue([
        ['read', 'Promotion'],
        ['batch_delete', 'Promotion'],
      ]);
    const ctx = makeCtx(
      [
        ['read', 'Promotion'],
        ['batch_delete', 'Promotion'],
      ],
      userWith(),
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});