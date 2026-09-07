import { RequestMethod, type ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ThrottlerGuard, type ThrottlerStorage } from '@nestjs/throttler';
import {
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import { PublicCatalogController } from './public-catalog.controller';
import { PublicCatalogModule } from '../public-catalog.module';

type ControllerHandler = (...args: never[]) => unknown;

// @nestjs/throttler v6 does not re-export ThrottlerStorageRecord from its
// package index, so the fake storage returns a structurally identical record.
type StorageRecord = {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
};

class RecordingThrottlerStorage implements ThrottlerStorage {
  readonly calls: Array<{ ttl: number; limit: number; name: string }> = [];

  increment(
    _key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    name: string,
  ): Promise<StorageRecord> {
    this.calls.push({ ttl, limit, name });
    return Promise.resolve({
      totalHits: 1,
      timeToExpire: ttl,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  }
}

const getControllerHandler = (name: string): ControllerHandler => {
  const descriptor = Object.getOwnPropertyDescriptor(
    PublicCatalogController.prototype,
    name,
  );

  if (!descriptor || typeof descriptor.value !== 'function') {
    throw new Error(`Missing PublicCatalogController handler: ${name}`);
  }

  return descriptor.value as ControllerHandler;
};

const createContext = (handler: ControllerHandler): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => PublicCatalogController,
    switchToHttp: () => ({
      getRequest: () => ({ ip: '203.0.113.8', headers: {} }),
      getResponse: () => ({ header: jest.fn() }),
    }),
  }) as unknown as ExecutionContext;

const createGuard = (storage: RecordingThrottlerStorage) => {
  const guard = new ThrottlerGuard(
    [
      { name: 'public-browse', ttl: 60_000, limit: 60 },
      { name: 'public-validate', ttl: 60_000, limit: 20 },
    ],
    storage,
    new Reflector(),
  );

  return guard;
};

describe('Throttler scope (CRITICAL-01 regression)', () => {
  it('should NOT register ThrottlerGuard as APP_GUARD in module providers', () => {
    // Extract module metadata to check providers
    const metadata = Reflect.getMetadata(
      'providers',
      PublicCatalogModule,
    ) as Array<{ provide?: unknown; useClass?: unknown }>;

    // Find any provider that uses APP_GUARD token
    const appGuardProviders = metadata.filter(
      (p) => typeof p === 'object' && p.provide === APP_GUARD,
    );

    // If any APP_GUARD provider exists and uses ThrottlerGuard, the test fails.
    // APP_GUARD is ALWAYS global in NestJS regardless of module — this is the bug.
    const hasThrottlerAsAppGuard = appGuardProviders.some(
      (p) => p.useClass === ThrottlerGuard,
    );

    expect(hasThrottlerAsAppGuard).toBe(false);
  });

  it('should apply ThrottlerGuard at controller level via @UseGuards', () => {
    // Verify the controller class has UseGuards metadata including ThrottlerGuard
    const guards = Reflect.getMetadata(
      '__guards__',
      PublicCatalogController,
    ) as unknown[];

    expect(guards).toContain(ThrottlerGuard);
  });

  it.each([
    ['getBranches', getControllerHandler('getBranches'), 'public-browse', 60],
    ['getProducts', getControllerHandler('getProducts'), 'public-browse', 60],
    ['getProduct', getControllerHandler('getProduct'), 'public-browse', 60],
    [
      'validateCartEndpoint',
      getControllerHandler('validateCartEndpoint'),
      'public-validate',
      20,
    ],
  ])(
    '%s executes only its named throttler',
    async (_name, handler, expectedName, expectedLimit) => {
      const storage = new RecordingThrottlerStorage();
      const guard = createGuard(storage);
      await guard.onModuleInit();

      await expect(guard.canActivate(createContext(handler))).resolves.toBe(
        true,
      );

      expect(storage.calls).toEqual([
        { name: expectedName, ttl: 60_000, limit: expectedLimit },
      ]);
    },
  );

  it('keeps exact public-validate policy metadata on the cart handler', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const handler = PublicCatalogController.prototype.validateCartEndpoint;
    const ctl = PublicCatalogController;
    const meta = (target: object, key: string | symbol): unknown =>
      Reflect.getMetadata(key, target);
    expect(meta(ctl, PATH_METADATA)).toBe('public/catalog');
    expect(meta(handler, PATH_METADATA)).toBe(':tenantSlug/cart/validate');
    expect(meta(handler, METHOD_METADATA)).toBe(RequestMethod.POST);
    expect(meta(handler, 'cache-control-header')).toBe('no-store');
    expect(meta(handler, `${THROTTLER_LIMIT}public-validate`)).toBe(20);
    expect(meta(handler, `${THROTTLER_TTL}public-validate`)).toBe(60_000);
  });
});
