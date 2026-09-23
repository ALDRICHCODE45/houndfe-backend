/**
 * pca-3c4c — promotion expiry AppModule wiring tests (RED → GREEN).
 *
 * This spec is the application-composition proof for the promotion-expiry
 * delivery path. It asserts on the static `MODULE_METADATA` of `AppModule`
 * (reflect-only, no DI boot) so a runtime boot cannot fail with a missing
 * provider while still guarding against a mis-wired composition.
 *
 * Contract under test (pca-3c4c):
 *   - `AppModule` imports the `PromotionExpiryModule` scanner so the
 *     `promotion.expiring.detected` producer is actually running.
 *   - `AppModule` imports the `PromotionExpiryOutboxModule` dedicated
 *     poller/dispatcher so produced rows have a durable consumer.
 *   - `AppModule` provides `PromotionExpiryInngestRegistrar` EXACTLY ONCE as a
 *     top-level provider so the `promotion-expiring-email` function is
 *     registered with the serve handler.
 *   - The existing capacity path is NOT regressed: `PromotionCapacityOutboxModule`
 *     stays imported and `PromotionCapacityInngestRegistrar` stays provided
 *     exactly once.
 *   - The two registrars are independent classes (no aliasing), so wiring one
 *     cannot silently replace the other.
 */
import { MODULE_METADATA } from '@nestjs/common/constants';

// AppModule's transitive graph contains one bare-root import
// (`src/products/products.service`) that Jest cannot resolve without a
// `modulePaths`/`baseUrl` mapping. Register a virtual mock so the metadata
// assertions below can load AppModule without resolving (or booting) that
// unrelated module.
jest.mock(
  'src/products/products.service',
  () => ({ ProductsService: class ProductsService {} }),
  { virtual: true },
);

import { AppModule } from '../../app.module';
import { PromotionCapacityOutboxModule } from '../outbox/promotion-capacity-outbox.module';
import { PromotionExpiryOutboxModule } from '../outbox/promotion-expiry-outbox.module';
import { PromotionExpiryModule } from '../expiry/promotion-expiry.module';
import { PromotionCapacityInngestRegistrar } from './promotion-capacity-inngest-registrar';
import { PromotionExpiryInngestRegistrar } from './promotion-expiry-inngest-registrar';

function appImports(): unknown[] {
  return Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[];
}

function appProviders(): unknown[] {
  return Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) as unknown[];
}

describe('AppModule promotion expiry wiring (pca-3c4c)', () => {
  it('imports the PromotionExpiryModule scanner', () => {
    expect(appImports()).toContain(PromotionExpiryModule);
  });

  it('imports the dedicated PromotionExpiryOutboxModule poller/dispatcher', () => {
    expect(appImports()).toContain(PromotionExpiryOutboxModule);
  });

  it('provides PromotionExpiryInngestRegistrar exactly once', () => {
    const matches = appProviders().filter(
      (provider) => provider === PromotionExpiryInngestRegistrar,
    );
    expect(matches).toHaveLength(1);
  });

  it('does not alias the expiry registrar to the capacity registrar', () => {
    expect(PromotionExpiryInngestRegistrar).not.toBe(
      PromotionCapacityInngestRegistrar,
    );
  });

  it('keeps the capacity outbox module imported (no near-capacity regression)', () => {
    expect(appImports()).toContain(PromotionCapacityOutboxModule);
  });

  it('keeps the capacity registrar provided exactly once (no near-capacity regression)', () => {
    const matches = appProviders().filter(
      (provider) => provider === PromotionCapacityInngestRegistrar,
    );
    expect(matches).toHaveLength(1);
  });

  it('provides both registrars so both Inngest functions are registered', () => {
    const providers = appProviders();
    expect(providers).toContain(PromotionExpiryInngestRegistrar);
    expect(providers).toContain(PromotionCapacityInngestRegistrar);
  });
});
