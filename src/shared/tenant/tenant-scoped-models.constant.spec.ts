import { TENANT_SCOPED_MODELS } from './tenant-scoped-models.constant';

describe('TENANT_SCOPED_MODELS — shipping quotes registration (shipping T3)', () => {
  it('scopes ShippingQuote by tenant', () => {
    expect(TENANT_SCOPED_MODELS.has('ShippingQuote')).toBe(true);
  });
});

describe('TENANT_SCOPED_MODELS — opening hours registration (shipping T7)', () => {
  it('scopes TenantOpeningHours by tenant', () => {
    expect(TENANT_SCOPED_MODELS.has('TenantOpeningHours')).toBe(true);
  });
});
