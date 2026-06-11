import 'reflect-metadata';
import { ServiceCredential } from '../../domain/service-credential.entity';
import {
  REQUIRED_SCOPES_KEY,
  RequiredScopes,
  credentialHasRequiredScopes,
} from './required-scopes.decorator';

describe('RequiredScopes', () => {
  it('stores normalized required scopes metadata on the handler', () => {
    class TestController {
      @RequiredScopes('catalog:read', ' catalog:read ', 'customers:write')
      handler(this: void) {}
    }

    const descriptor = Object.getOwnPropertyDescriptor(
      TestController.prototype,
      'handler',
    );
    const handler = descriptor?.value as object | undefined;
    expect(handler).toBeDefined();

    const metadata = Reflect.getMetadata(
      REQUIRED_SCOPES_KEY,
      handler,
    ) as string[];

    expect(metadata).toEqual(['catalog:read', 'customers:write']);
  });

  it('checks all required scopes against the credential', () => {
    const credential = ServiceCredential.fromPersistence({
      id: 'cred-1',
      tenantId: 'tenant-1',
      name: 'Catalog Bot',
      hashedKey: 'hash-123',
      scopes: ['catalog:read', 'customers:write'],
      isActive: true,
      lastUsedAt: null,
      rateLimit: 60,
      createdAt: new Date('2026-06-10T10:00:00.000Z'),
      revokedAt: null,
    });

    expect(
      credentialHasRequiredScopes(credential, [
        'catalog:read',
        'customers:write',
      ]),
    ).toBe(true);
    expect(
      credentialHasRequiredScopes(credential, [
        'catalog:read',
        'pricing:evaluate',
      ]),
    ).toBe(false);
  });
});
