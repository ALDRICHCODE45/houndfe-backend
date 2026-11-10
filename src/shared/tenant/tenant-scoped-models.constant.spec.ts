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

describe('TENANT_SCOPED_MODELS — chatbot request inbox registration (human-intervention unit 2)', () => {
  it.each([
    'ChatbotRequest',
    'ChatbotRequestEvent',
    'ChatbotCustomerGroup',
    'ChatbotRequestFolioCounter',
  ])('scopes %s by tenant', (model) => {
    expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
  });
});
