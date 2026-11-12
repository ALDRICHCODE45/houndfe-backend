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

describe('TENANT_SCOPED_MODELS — notifications registration (human-intervention unit 6)', () => {
  it('scopes Notification by tenant', () => {
    expect(TENANT_SCOPED_MODELS.has('Notification')).toBe(true);
  });

  it('leaves the per-person preference unscoped (no tenantId column)', () => {
    expect(TENANT_SCOPED_MODELS.has('NotificationPreference')).toBe(false);
  });
});

describe('TENANT_SCOPED_MODELS — chatbot request inbox registration (human-intervention unit 2)', () => {
  it.each([
    'ChatbotRequest',
    'ChatbotRequestEvent',
    'ChatbotCustomerGroup',
    'ChatbotRequestFolioCounter',
    'StaffCommandReceipt',
    'ChatbotFeedItem',
    'ChatbotFeedRetention',
  ])('scopes %s by tenant', (model) => {
    expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
  });
});

describe('TENANT_SCOPED_MODELS — chatbot attention settings registration (human-intervention unit 7a)', () => {
  it.each([
    'ChatbotAttentionSettings',
    'ChatbotAttentionSettingsEvent',
    'RealtimeEvent',
    'RealtimeEventRetention',
  ])('scopes %s by tenant', (model) => {
    expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
  });
});

describe('TENANT_SCOPED_MODELS — conversation mirror registration (human-intervention unit 9)', () => {
  it.each(['ChatbotConversation', 'ConversationMessage', 'ConversationMedia'])(
    'scopes %s by tenant',
    (model) => {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    },
  );
});

describe('TENANT_SCOPED_MODELS — conversation media intents (human-intervention unit 9, S2)', () => {
  it('scopes ConversationMediaIntent by tenant', () => {
    expect(TENANT_SCOPED_MODELS.has('ConversationMediaIntent')).toBe(true);
  });

  it('leaves the sweep cursor unscoped (a single global row, no tenantId)', () => {
    expect(TENANT_SCOPED_MODELS.has('ConversationMediaOrphanSweep')).toBe(
      false,
    );
  });
});

describe('TENANT_SCOPED_MODELS — live conversation registration (human-intervention unit 11)', () => {
  it.each(['ChatbotLiveSession', 'ChatbotSessionTemplate'])(
    'scopes %s by tenant',
    (model) => {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    },
  );
});

describe('TENANT_SCOPED_MODELS — scheduled conversations (human-intervention unit 14)', () => {
  it('scopes ScheduledSlotCounter by tenant', () => {
    expect(TENANT_SCOPED_MODELS.has('ScheduledSlotCounter')).toBe(true);
  });
});
