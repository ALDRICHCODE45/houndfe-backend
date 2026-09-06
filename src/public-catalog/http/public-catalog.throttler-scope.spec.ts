import { APP_GUARD } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import { PublicCatalogController } from './public-catalog.controller';
import { PublicCatalogModule } from '../public-catalog.module';

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
