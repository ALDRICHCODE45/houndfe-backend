/**
 * PermissionsGuard unit spec — delivery-routes / WU3 (3.16).
 *
 * Covers:
 *   - Backward compatibility: routes without `@RequirePermissions` always
 *     allow (mirrors WU1 behavior).
 *   - Coarse check: a string subject is evaluated against the user's
 *     ability as before.
 *   - Subject-instance condition: when `request.params.id` is present AND
 *     a `SUBJECT_INSTANCE_RESOLVERS` entry exists, the guard re-checks
 *     with `subject(...)` so CASL evaluates the `{ driverUserId }`
 *     condition against the resolved instance. The guard throws
 *     `InsufficientPermissionsError` on a foreign subject and defers on
 *     null (cross-tenant / missing — the service surfaces the 404).
 *   - Existing subjects are unaffected by the registry seam.
 *
 * The spec fakes the CaslAbilityFactory via DI replacement; the
 * `SubjectInstanceResolverRegistry` is the static seam so the spec
 * resets it between tests via the `__resetForTests` hook.
 */
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { subject as caslSubject } from '@casl/ability';
import { CaslAbilityFactory } from '../../casl-ability.factory';
import { PermissionsGuard } from './permissions.guard';
import {
  SubjectInstanceResolver,
  SubjectInstanceResolverRegistry,
} from '../subject-instance-resolver';
import { InsufficientPermissionsError } from '../../../shared/domain/domain-error';

interface MockRequest {
  user?: { userId: string; tenantId: string; isSuperAdmin: boolean };
  params?: Record<string, unknown>;
  ability?: unknown;
}

function makeContext(req: MockRequest): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

function makeReflectorWith(
  permissions: Array<[string, string]> | null,
): jest.Mocked<Reflector> {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(permissions),
  } as unknown as jest.Mocked<Reflector>;
}

function makeFactoryWith(
  ability: unknown,
): jest.Mocked<CaslAbilityFactory> {
  return {
    createForUser: jest.fn().mockResolvedValue(ability),
  } as unknown as jest.Mocked<CaslAbilityFactory>;
}

beforeEach(() => {
  SubjectInstanceResolverRegistry.__resetForTests();
});

afterAll(() => {
  SubjectInstanceResolverRegistry.__resetForTests();
});

describe('PermissionsGuard (delivery-routes / WU3 — subject-instance condition)', () => {
  it('Given no @RequirePermissions metadata, when canActivate runs, then it returns true without building an ability', async () => {
    const reflector = makeReflectorWith(null);
    const factory = makeFactoryWith(null);
    const guard = new PermissionsGuard(reflector, factory);

    const result = await guard.canActivate(
      makeContext({ user: { userId: 'u1', tenantId: 't1', isSuperAdmin: false } }),
    );

    expect(result).toBe(true);
    expect(factory.createForUser).not.toHaveBeenCalled();
  });

  it('Given a route with no user on the request, when canActivate runs, then it throws UnauthorizedException', async () => {
    const reflector = makeReflectorWith([['read', 'DeliveryRoute']]);
    const factory = makeFactoryWith({});
    const guard = new PermissionsGuard(reflector, factory);

    await expect(
      guard.canActivate(makeContext({ params: {} })),
    ).rejects.toMatchObject({ message: expect.stringMatching(/not authenticated/i) });
  });

  it('Given a coarse ability denial (no driver condition), when canActivate runs, then it throws InsufficientPermissionsError and never evaluates the resolver', async () => {
    const reflector = makeReflectorWith([['update', 'DeliveryRoute']]);
    const ability = {
      can: jest.fn(() => false), // coarse check fails
    };
    const factory = makeFactoryWith(ability);
    const resolver = jest.fn(async () => ({ driverUserId: 'driver-2' }));
    SubjectInstanceResolverRegistry.register('DeliveryRoute', resolver);
    const guard = new PermissionsGuard(reflector, factory);

    await expect(
      guard.canActivate(
        makeContext({
          user: { userId: 'driver-1', tenantId: 't1', isSuperAdmin: false },
          params: { id: 'route-1' },
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientPermissionsError);
    // Resolver MUST NOT be consulted when the coarse check already fails.
    expect(resolver).not.toHaveBeenCalled();
  });

  it('Given a driver-only caller and a route they own, when canActivate runs, then the guard passes (resolver returns matching driverUserId)', async () => {
    const reflector = makeReflectorWith([['update', 'DeliveryRoute']]);
    // Track which subject the guard re-checks with so we can inspect it.
    let lastTaggedSubject: unknown = undefined;
    const ability = {
      can: jest.fn((action: string, subject: unknown) => {
        // Coarse: any DeliveryRoute action.
        if (subject === 'DeliveryRoute') return true;
        // Tagged: only the matching driverUserId. The guard creates a
        // FRESH `subject(...)` instance, so we can't compare by reference
        // — instead, inspect the driver's id by re-reading the tagged
        // shape's `driverUserId` field via the CASL detection symbol.
        const tagged = subject as { driverUserId?: unknown } | undefined;
        if (tagged && typeof tagged === 'object' && 'driverUserId' in tagged) {
          lastTaggedSubject = tagged;
          return tagged.driverUserId === 'driver-1';
        }
        return false;
      }),
    };
    const factory = makeFactoryWith(ability);
    const resolver: SubjectInstanceResolver = {
      resolveSubject: async () => ({ driverUserId: 'driver-1' }),
    };
    SubjectInstanceResolverRegistry.register('DeliveryRoute', resolver);
    const guard = new PermissionsGuard(reflector, factory);

    const result = await guard.canActivate(
      makeContext({
        user: { userId: 'driver-1', tenantId: 't1', isSuperAdmin: false },
        params: { id: 'route-1' },
      }),
    );

    expect(result).toBe(true);
    expect(ability.can).toHaveBeenCalledWith('update', 'DeliveryRoute');
    // The guard consulted the resolver and re-checked against a tagged
    // subject with driverUserId = driver-1.
    expect(lastTaggedSubject).toBeDefined();
    expect((lastTaggedSubject as { driverUserId: string }).driverUserId).toBe('driver-1');
  });

  it('Given a driver-only caller and a route owned by another driver, when canActivate runs, then the guard throws InsufficientPermissionsError', async () => {
    const reflector = makeReflectorWith([['update', 'DeliveryRoute']]);
    const ability = {
      can: jest.fn((action: string, subject: unknown) => {
        // Coarse check passes (driver has the permission at all).
        if (subject === 'DeliveryRoute') return true;
        // Tagged check: foreign driverUserId MUST fail.
        const tagged = subject as { driverUserId?: unknown } | undefined;
        if (tagged && typeof tagged === 'object' && 'driverUserId' in tagged) {
          return tagged.driverUserId === 'driver-1';
        }
        return false;
      }),
    };
    const factory = makeFactoryWith(ability);
    const resolver: SubjectInstanceResolver = {
      resolveSubject: async () => ({ driverUserId: 'driver-2' }),
    };
    SubjectInstanceResolverRegistry.register('DeliveryRoute', resolver);
    const guard = new PermissionsGuard(reflector, factory);

    await expect(
      guard.canActivate(
        makeContext({
          user: { userId: 'driver-1', tenantId: 't1', isSuperAdmin: false },
          params: { id: 'route-1' },
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientPermissionsError);
  });

  it('Given a resolver returning null (cross-tenant / missing), when canActivate runs, then the guard defers (no throw) so the service layer surfaces 404', async () => {
    const reflector = makeReflectorWith([['update', 'DeliveryRoute']]);
    const ability = {
      can: jest.fn((action: string, subject: unknown) =>
        subject === 'DeliveryRoute' ? true : false,
      ),
    };
    const factory = makeFactoryWith(ability);
    const resolver: SubjectInstanceResolver = {
      resolveSubject: async () => null,
    };
    SubjectInstanceResolverRegistry.register('DeliveryRoute', resolver);
    const guard = new PermissionsGuard(reflector, factory);

    const result = await guard.canActivate(
      makeContext({
        user: { userId: 'driver-1', tenantId: 't1', isSuperAdmin: false },
        params: { id: 'missing-route' },
      }),
    );

    expect(result).toBe(true);
  });

  it('Given no resolver registered for the subject, when canActivate runs, then the guard only does the coarse check (backward compatible)', async () => {
    const reflector = makeReflectorWith([['read', 'Product']]);
    const ability = {
      can: jest.fn(() => true),
    };
    const factory = makeFactoryWith(ability);
    const guard = new PermissionsGuard(reflector, factory);

    const result = await guard.canActivate(
      makeContext({
        user: { userId: 'u1', tenantId: 't1', isSuperAdmin: false },
        params: { id: 'product-1' },
      }),
    );

    expect(result).toBe(true);
    expect(ability.can).toHaveBeenCalledTimes(1);
    expect(ability.can).toHaveBeenCalledWith('read', 'Product');
  });

  it('Given a request with no `params.id`, when canActivate runs, then the guard only does the coarse check (no resolver invocation)', async () => {
    const reflector = makeReflectorWith([['read', 'DeliveryRoute']]);
    const ability = {
      can: jest.fn(() => true),
    };
    const factory = makeFactoryWith(ability);
    const resolver = jest.fn(async () => ({ driverUserId: 'driver-1' }));
    SubjectInstanceResolverRegistry.register('DeliveryRoute', resolver);
    const guard = new PermissionsGuard(reflector, factory);

    const result = await guard.canActivate(
      makeContext({
        user: { userId: 'driver-1', tenantId: 't1', isSuperAdmin: false },
        params: {},
      }),
    );

    expect(result).toBe(true);
    // No id in params ⇒ no resolver invocation.
    expect(resolver).not.toHaveBeenCalled();
  });

  it('Given a passing guard, the built ability is attached to the request so the service layer can perform list-scope filtering', async () => {
    const reflector = makeReflectorWith([['read', 'DeliveryRoute']]);
    const builtAbility = { can: jest.fn(() => true) };
    const factory = makeFactoryWith(builtAbility);
    const guard = new PermissionsGuard(reflector, factory);
    const req: MockRequest = {
      user: { userId: 'u1', tenantId: 't1', isSuperAdmin: false },
      params: {},
    };

    await guard.canActivate(makeContext(req));

    expect(req.ability).toBe(builtAbility);
  });
});
