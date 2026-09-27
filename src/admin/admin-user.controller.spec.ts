import { createMongoAbility } from '@casl/ability';
import { AdminUserController } from './admin-user.controller';
import { AdminUserService } from './admin-user.service';
import type { AppAbility } from '../auth/authorization/domain/permission';

it('passes the actual pre-mutation guard ability and trusted request actor', () => {
  const service = { update: jest.fn().mockReturnValue({ id: 'target' }) };
  const controller = new AdminUserController(
    service as unknown as AdminUserService,
  );
  const request = {
    user: {
      userId: 'actor',
      email: 'actor@example.com',
      tenantId: 'tenant',
      tenantSlug: 'tenant',
      isSuperAdmin: false,
    },
    ability: createMongoAbility<AppAbility>([
      { action: 'update', subject: 'User' },
    ]),
  };
  const dto = { name: 'Name' };
  const result = controller.update('target', dto, request);
  expect(result).toEqual({ id: 'target' });
  expect(service.update).toHaveBeenCalledWith(
    'target',
    dto,
    request.user,
    request.ability,
  );
});
