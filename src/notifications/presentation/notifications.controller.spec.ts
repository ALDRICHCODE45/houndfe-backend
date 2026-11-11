import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import type { NotificationsService } from '../application/notifications.service';
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
  const controller = new NotificationsController(
    service as unknown as NotificationsService,
  );
  // The caller is always the JWT principal.
  const req = { user: { userId: 'jwt-user', tenantId: 't1' } } as never;
  return { service, controller, req };
}

describe('NotificationsController', () => {
  it('guards every route: JwtAuthGuard → TenantContextGuard → ActiveUserGuard', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      NotificationsController,
    ) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, TenantContextGuard, ActiveUserGuard]);
  });

  it('always acts as the JWT user and never takes a user from the request', async () => {
    const { controller, service, req } = setup();
    await controller.list({ limit: 5 }, req);
    await controller.unreadCount(req);
    await controller.readAll(req);
    await controller.read('6f1d3a2e-0b7c-4e55-9a31-2c7d8e9f0a1b', req);
    await controller.getPreferences(req);

    expect(service.list).toHaveBeenCalledWith('jwt-user', { limit: 5 });
    expect(service.unreadCount).toHaveBeenCalledWith('jwt-user');
    expect(service.markAllRead).toHaveBeenCalledWith('jwt-user');
    expect(service.markRead).toHaveBeenCalledWith(
      'jwt-user',
      '6f1d3a2e-0b7c-4e55-9a31-2c7d8e9f0a1b',
    );
    expect(service.getPreferences).toHaveBeenCalledWith('jwt-user');
  });

  it('PUT preferences passes only the flags that were sent', async () => {
    const { controller, service, req } = setup();
    await controller.setPreferences({ soundEnabled: false }, req);
    expect(service.setPreferences).toHaveBeenCalledWith('jwt-user', {
      soundEnabled: false,
    });
  });

  it('PUT preferences with no flag is a 400 and writes nothing', () => {
    const { controller, service, req } = setup();
    expect(() => controller.setPreferences({}, req)).toThrow(
      BadRequestException,
    );
    expect(service.setPreferences).not.toHaveBeenCalled();
  });
});
