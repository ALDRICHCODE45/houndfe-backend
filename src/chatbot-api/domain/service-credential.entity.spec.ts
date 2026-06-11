import { ServiceCredential } from './service-credential.entity';

describe('ServiceCredential', () => {
  it('creates an active credential with normalized scopes', () => {
    const credential = ServiceCredential.create({
      id: 'cred-1',
      tenantId: 'tenant-1',
      name: '  Bot Credential  ',
      hashedKey: 'hash-123',
      scopes: ['catalog:read', ' catalog:read ', 'customers:write'],
    });

    expect(credential.name).toBe('Bot Credential');
    expect(credential.scopes).toEqual(['catalog:read', 'customers:write']);
    expect(credential.isActive).toBe(true);
    expect(credential.rateLimit).toBe(60);
    expect(credential.hasScope('catalog:read')).toBe(true);
  });

  it('restores persistence fields and rejects scopes it does not have', () => {
    const lastUsedAt = new Date('2026-06-10T10:00:00.000Z');
    const revokedAt = new Date('2026-06-10T11:00:00.000Z');

    const credential = ServiceCredential.fromPersistence({
      id: 'cred-2',
      tenantId: 'tenant-2',
      name: 'Revoked Bot',
      hashedKey: 'hash-456',
      scopes: ['pricing:evaluate'],
      isActive: false,
      lastUsedAt,
      rateLimit: 15,
      createdAt: new Date('2026-06-09T09:00:00.000Z'),
      revokedAt,
    });

    expect(credential.lastUsedAt).toEqual(lastUsedAt);
    expect(credential.revokedAt).toEqual(revokedAt);
    expect(credential.isActive).toBe(false);
    expect(credential.rateLimit).toBe(15);
    expect(credential.hasScope('catalog:read')).toBe(false);
  });
});
