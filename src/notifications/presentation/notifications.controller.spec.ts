import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import type { NotificationsService } from '../application/notifications.service';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationsController } from './notifications.controller';

function setup() {
  const service = {
    list: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    unreadCount: jest.fn().mockResolvedValue({ count: 0 }),
    markRead: jest.fn().mockResolvedValue({}),
    markAllRead: jest.fn().mockResolvedValue({ updated: 0 }),
    getPreferences: jest.fn().mockResolvedValue({}),
    setPreferences: jest.fn().mockResolvedValue({}),
  };
  const typed = service as unknown as NotificationsService;
  // The caller is always the JWT principal.
  const req = { user: { userId: 'jwt-user', tenantId: 't1' } } as never;
  return {
    service,
    controller: new NotificationsController(typed),
    preferences: new NotificationPreferencesController(typed),
    req,
  };
}

const GUARDS = [JwtAuthGuard, TenantContextGuard, ActiveUserGuard];

describe('NotificationsController', () => {
  it('guards every route: JwtAuthGuard → TenantContextGuard → ActiveUserGuard', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, NotificationsController),
    ).toEqual(GUARDS);
  });

  it('always acts as the JWT user and never takes a user from the request', async () => {
    const { controller, service, req } = setup();
    await controller.list({ limit: 5 }, req);
    await controller.unreadCount(req);
    await controller.readAll(req);
    await controller.read('6f1d3a2e-0b7c-4e55-9a31-2c7d8e9f0a1b', req);

    expect(service.list).toHaveBeenCalledWith('jwt-user', { limit: 5 });
    expect(service.unreadCount).toHaveBeenCalledWith('jwt-user');
    expect(service.markAllRead).toHaveBeenCalledWith('jwt-user');
    expect(service.markRead).toHaveBeenCalledWith(
      'jwt-user',
      '6f1d3a2e-0b7c-4e55-9a31-2c7d8e9f0a1b',
    );
  });

  it('no longer serves preferences under /notifications (contract §5.2)', () => {
    expect(NotificationsController.prototype).not.toHaveProperty(
      'getPreferences',
    );
    expect(NotificationsController.prototype).not.toHaveProperty(
      'setPreferences',
    );
  });
});

describe('NotificationPreferencesController (GET/PATCH /me/notification-preferences)', () => {
  it('lives at the contract path with the same guards', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, NotificationPreferencesController),
    ).toBe('me/notification-preferences');
    expect(
      Reflect.getMetadata(GUARDS_METADATA, NotificationPreferencesController),
    ).toEqual(GUARDS);
  });

  it("GET reads the JWT user's preferences", async () => {
    const { preferences, service, req } = setup();
    await preferences.get(req);
    expect(service.getPreferences).toHaveBeenCalledWith('jwt-user');
  });

  it('PATCH passes only the flags that were sent', async () => {
    const { preferences, service, req } = setup();
    await preferences.patch({ soundEnabled: false }, req);
    expect(service.setPreferences).toHaveBeenCalledWith('jwt-user', {
      soundEnabled: false,
    });
  });

  it('PATCH with no flag is a 400 and writes nothing', () => {
    const { preferences, service, req } = setup();
    expect(() => preferences.patch({}, req)).toThrow(BadRequestException);
    expect(service.setPreferences).not.toHaveBeenCalled();
  });
});
