import {
  ExecutionContext,
  ForbiddenException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { PUBLIC_CATALOG_REPOSITORY } from '../../../public-catalog/application/ports/public-catalog.repository';
import { SAT_KEY_REPOSITORY } from '../../../sat-catalog/domain/sat-key.repository';
import type { TenantClsStore } from '../../../shared/tenant/tenant-cls-store.interface';
import { ChatbotApiModule } from '../../chatbot-api.module';
import { ServiceCredential } from '../../domain/service-credential.entity';
import {
  IServiceCredentialRepository,
  SERVICE_CREDENTIAL_REPOSITORY,
} from '../../domain/service-credential.repository';
import { RequiredScopes } from '../decorators/required-scopes.decorator';
import { ServiceAuthGuard } from './service-auth.guard';

function makeCredential(
  overrides: Partial<ReturnType<ServiceCredential['toPersistence']>> = {},
) {
  return ServiceCredential.fromPersistence({
    id: 'cred-1',
    tenantId: 'tenant-1',
    name: 'Chatbot Bot',
    hashedKey: createHash('sha256').update('svc_valid-key').digest('hex'),
    scopes: ['catalog:read', 'customers:write'],
    isActive: true,
    lastUsedAt: null,
    rateLimit: 60,
    createdAt: new Date('2026-06-10T10:00:00.000Z'),
    revokedAt: null,
    ...overrides,
  });
}

describe('ServiceAuthGuard', () => {
  let repository: jest.Mocked<IServiceCredentialRepository>;
  let cls: { set: jest.Mock };
  let reflector: Reflector;
  let guard: ServiceAuthGuard;

  class ScopedController {
    @RequiredScopes('catalog:read')
    readCatalog(this: void) {}
  }

  class MissingScopeController {
    @RequiredScopes('pricing:evaluate')
    pricing(this: void) {}
  }

  const handler = Object.getOwnPropertyDescriptor(
    ScopedController.prototype,
    'readCatalog',
  )?.value as () => void;
  const missingScopeHandler = Object.getOwnPropertyDescriptor(
    MissingScopeController.prototype,
    'pricing',
  )?.value as () => void;

  beforeEach(() => {
    repository = {
      findByHashedKey: jest.fn(),
      touchLastUsedAt: jest.fn(),
    };
    cls = { set: jest.fn() };
    reflector = new Reflector();
    guard = new ServiceAuthGuard(
      repository,
      cls as unknown as ClsService<TenantClsStore>,
      reflector,
    );
  });

  function mockContext(input?: {
    authorization?: string;
    branchId?: string;
    handler?: () => void;
  }): ExecutionContext {
    const setHeader = jest.fn();
    const request = {
      headers: {
        authorization: input?.authorization,
        'x-branch-id': input?.branchId,
      },
      serviceCredential: undefined as unknown,
    };

    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setHeader }),
      }),
      getHandler: () => input?.handler ?? handler,
      getClass: () => ScopedController,
    } as unknown as ExecutionContext;
  }

  it('authorizes a valid service credential, updates last-used, and sets CLS context', async () => {
    const credential = makeCredential();
    repository.findByHashedKey.mockResolvedValue(credential);
    repository.touchLastUsedAt.mockResolvedValue();

    const context = mockContext({
      authorization: 'Bearer svc_valid-key',
      branchId: 'tenant-1',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(repository.findByHashedKey.mock.calls).toEqual([
      [createHash('sha256').update('svc_valid-key').digest('hex')],
    ]);
    expect(repository.touchLastUsedAt.mock.calls).toEqual([['cred-1']]);
    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
    expect(cls.set).toHaveBeenCalledWith('userId', 'service:cred-1');
  });

  it('rejects revoked credentials and leaves CLS untouched', async () => {
    repository.findByHashedKey.mockResolvedValue(
      makeCredential({ revokedAt: new Date('2026-06-10T12:00:00.000Z') }),
    );

    await expect(
      guard.canActivate(mockContext({ authorization: 'Bearer svc_valid-key' })),
    ).rejects.toThrow(UnauthorizedException);

    expect(cls.set).not.toHaveBeenCalled();
    expect(repository.touchLastUsedAt.mock.calls).toHaveLength(0);
  });

  it('rejects requests for a different branch than the credential scope', async () => {
    repository.findByHashedKey.mockResolvedValue(makeCredential());

    await expect(
      guard.canActivate(
        mockContext({
          authorization: 'Bearer svc_valid-key',
          branchId: 'tenant-2',
        }),
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(cls.set).not.toHaveBeenCalled();
    expect(repository.touchLastUsedAt.mock.calls).toHaveLength(0);
  });

  it('rejects missing, invalid, or out-of-scope authorization attempts', async () => {
    await expect(guard.canActivate(mockContext())).rejects.toThrow(
      UnauthorizedException,
    );

    await expect(
      guard.canActivate(mockContext({ authorization: 'Bearer human-token' })),
    ).rejects.toThrow(UnauthorizedException);

    repository.findByHashedKey.mockResolvedValue(makeCredential());
    await expect(
      guard.canActivate(
        mockContext({
          authorization: 'Bearer svc_valid-key',
          handler: missingScopeHandler,
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects requests after the credential exceeds its configured rate limit window', async () => {
    repository.findByHashedKey.mockResolvedValue(
      makeCredential({ rateLimit: 1 }),
    );
    repository.touchLastUsedAt.mockResolvedValue();

    const firstContext = mockContext({
      authorization: 'Bearer svc_valid-key',
    });
    const secondContext = mockContext({
      authorization: 'Bearer svc_valid-key',
    });

    await expect(guard.canActivate(firstContext)).resolves.toBe(true);
    await expect(guard.canActivate(secondContext)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it('rejects credentials whose persisted hash does not match the computed token hash', async () => {
    repository.findByHashedKey.mockResolvedValue(
      makeCredential({
        hashedKey: createHash('sha256').update('svc_other-key').digest('hex'),
      }),
    );

    await expect(
      guard.canActivate(
        mockContext({
          authorization: 'Bearer svc_valid-key',
          branchId: 'tenant-1',
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);

    expect(repository.touchLastUsedAt.mock.calls).toHaveLength(0);
    expect(cls.set).not.toHaveBeenCalled();
  });

  it('rejects a wrong service key with the same raw length as the valid credential', async () => {
    repository.findByHashedKey.mockResolvedValue(makeCredential());

    await expect(
      guard.canActivate(
        mockContext({
          authorization: 'Bearer svc_other-key',
          branchId: 'tenant-1',
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);

    expect(repository.touchLastUsedAt.mock.calls).toHaveLength(0);
    expect(cls.set).not.toHaveBeenCalled();
  });

  it('rejects a wrong-length service key without throwing from timing-safe comparison', async () => {
    repository.findByHashedKey.mockResolvedValue(makeCredential());

    await expect(
      guard.canActivate(
        mockContext({
          authorization: 'Bearer svc_short',
          branchId: 'tenant-1',
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);

    expect(repository.touchLastUsedAt.mock.calls).toHaveLength(0);
    expect(cls.set).not.toHaveBeenCalled();
  });

  it('is provided by ChatbotApiModule with CLS support', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_SECRET: 'test-secret',
              SPACES_ACCESS_KEY_ID: 'test-access-key',
              SPACES_BUCKET: 'test-bucket',
              SPACES_ENDPOINT: 'https://spaces.example.test',
              SPACES_PUBLIC_BASE_URL: 'https://cdn.example.test',
              SPACES_REGION: 'test-region',
              SPACES_SECRET_ACCESS_KEY: 'test-secret-key',
            }),
          ],
        }),
        ClsModule.forRoot({ global: true }),
        EventEmitterModule.forRoot(),
        ChatbotApiModule,
      ],
    })
      .overrideProvider(SERVICE_CREDENTIAL_REPOSITORY)
      .useValue(repository)
      .overrideProvider(PUBLIC_CATALOG_REPOSITORY)
      .useValue({
        findActiveBranches: jest.fn(),
        findProducts: jest.fn(),
        findCategoryFacets: jest.fn(),
        findProductById: jest.fn(),
      })
      .overrideProvider(SAT_KEY_REPOSITORY)
      .useValue({
        search: jest.fn(),
        findByKey: jest.fn(),
        exists: jest.fn(),
      })
      .compile();

    expect(moduleRef.get(ServiceAuthGuard)).toBeInstanceOf(ServiceAuthGuard);
  });
});
