import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PublicCatalogModule } from '../public-catalog.module';

describe('Throttler scope (CRITICAL-01 regression)', () => {
  it('should NOT register ThrottlerGuard as APP_GUARD in module providers', () => {
    // Extract module metadata to check providers
    const metadata = Reflect.getMetadata(
      'providers',
      PublicCatalogModule,
    ) as any[];

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
    const { PublicCatalogController } = require('./public-catalog.controller');
    const guards: Function[] =
      Reflect.getMetadata('__guards__', PublicCatalogController) ?? [];

    expect(guards).toContain(ThrottlerGuard);
  });
});
