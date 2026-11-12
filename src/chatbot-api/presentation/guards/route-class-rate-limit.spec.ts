/**
 * R2 (contract §10.1): the guard picks the budget by route class. Routes
 * without a class keep the credential's own `rateLimit` (the class `default`),
 * so the existing chatbot-api routes see the same budget as before; the new
 * routes use `write`, `read` or `feed`.
 */
import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../../../shared/tenant/tenant-cls-store.interface';
import { ServiceCredential } from '../../domain/service-credential.entity';
import type { IServiceCredentialRepository } from '../../domain/service-credential.repository';
import { BotApplicationOutcomeController } from '../../../human-decisions/presentation/bot-application-outcome.controller';
import { BotRestockIntakeController } from '../../../human-decisions/presentation/bot-restock-intake.controller';
import { BotRestockPollController } from '../../../human-decisions/presentation/bot-restock-poll.controller';
import { BotRouteClass, ROUTE_CLASS_KEY } from './route-class';
import {
  DEFAULT_CLASS_LIMITS,
  type RouteRateLimiter,
} from './route-rate-limiter';
import { ServiceAuthGuard } from './service-auth.guard';

function credential(rateLimit = 60) {
  return ServiceCredential.fromPersistence({
    id: 'cred-1',
    tenantId: 'tenant-1',
    name: 'Bot',
    hashedKey: createHash('sha256').update('svc_key').digest('hex'),
    scopes: ['requests:create'],
    isActive: true,
    lastUsedAt: null,
    rateLimit,
    createdAt: new Date('2026-11-10T10:00:00.000Z'),
    revokedAt: null,
  });
}

class Routes {
  @BotRouteClass('write')
  write(this: void) {}

  @BotRouteClass('feed')
  feed(this: void) {}

  @BotRouteClass('control')
  control(this: void) {}

  @BotRouteClass('humanDecisions')
  humanDecisions(this: void) {}

  plain(this: void) {}
}
const handlerOf = (name: keyof Routes) =>
  Object.getOwnPropertyDescriptor(Routes.prototype, name)?.value as () => void;

describe('ServiceAuthGuard route classes', () => {
  let repository: jest.Mocked<IServiceCredentialRepository>;
  let check: jest.Mock;
  let limiter: RouteRateLimiter;
  let setHeader: jest.Mock;
  let guard: ServiceAuthGuard;

  const context = (handler: () => void) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: 'Bearer svc_key' },
        }),
        getResponse: () => ({ setHeader }),
      }),
      getHandler: () => handler,
      getClass: () => Routes,
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    repository = {
      findByHashedKey: jest.fn().mockResolvedValue(credential(45)),
      touchLastUsedAt: jest.fn().mockResolvedValue(undefined),
    };
    check = jest.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
    limiter = { check };
    setHeader = jest.fn();
    guard = new ServiceAuthGuard(
      repository,
      { set: jest.fn() } as unknown as ClsService<TenantClsStore>,
      new Reflector(),
      limiter,
    );
  });

  it('charges a route without a class to `default` with the credential rateLimit', async () => {
    await guard.canActivate(context(handlerOf('plain')));

    expect(check).toHaveBeenCalledWith({
      credentialId: 'cred-1',
      routeClass: 'default',
      defaultLimit: 45,
    });
  });

  it.each(['write', 'feed', 'control'] as const)(
    'charges a %s route to its own class with the class default',
    async (name) => {
      await guard.canActivate(context(handlerOf(name)));

      expect(check).toHaveBeenCalledWith({
        credentialId: 'cred-1',
        routeClass: name,
        defaultLimit: DEFAULT_CLASS_LIMITS[name],
      });
    },
  );

  it('gives the control class (session-ack) its own bucket, so a mirror burst never starves it', async () => {
    await guard.canActivate(context(handlerOf('control')));

    expect(check).toHaveBeenCalledWith({
      credentialId: 'cred-1',
      routeClass: 'control',
      defaultLimit: 120,
    });
  });

  it('charges the human-decision routes to their own class with the credential rateLimit', async () => {
    await guard.canActivate(context(handlerOf('humanDecisions')));

    expect(check).toHaveBeenCalledWith({
      credentialId: 'cred-1',
      routeClass: 'humanDecisions',
      defaultLimit: 45,
    });
  });

  it.each([
    BotRestockIntakeController,
    BotRestockPollController,
    BotApplicationOutcomeController,
  ])('declares `humanDecisions` on %p', (controller) => {
    expect(Reflect.getMetadata(ROUTE_CLASS_KEY, controller)).toBe(
      'humanDecisions',
    );
  });

  it('answers 429 with Retry-After rounded up when the class budget is spent', async () => {
    check.mockResolvedValue({ allowed: false, retryAfterMs: 1_200 });

    await expect(
      guard.canActivate(context(handlerOf('write'))),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '2');
  });

  it('keeps the in-memory limiter per class when no shared limiter is wired', async () => {
    repository.findByHashedKey.mockResolvedValue(credential(1));
    const standalone = new ServiceAuthGuard(
      repository,
      { set: jest.fn() } as unknown as ClsService<TenantClsStore>,
      new Reflector(),
    );

    await expect(
      standalone.canActivate(context(handlerOf('plain'))),
    ).resolves.toBe(true);
    await expect(
      standalone.canActivate(context(handlerOf('plain'))),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    // another class has its own bucket
    await expect(
      standalone.canActivate(context(handlerOf('write'))),
    ).resolves.toBe(true);
  });
});
