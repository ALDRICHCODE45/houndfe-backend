import { UsersController } from './users.controller';

describe('UsersController', () => {
  it('delegates assignable listing to service', async () => {
    const usersService = {
      findAssignable: jest
        .fn()
        .mockResolvedValue([{ id: 'u-1', name: 'Ana Pérez' }]),
    };
    const controller = new UsersController(usersService as never);

    const result = await controller.findAssignable();

    expect(usersService.findAssignable).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: 'u-1', name: 'Ana Pérez' }]);
  });

  it('delegates assignable-drivers listing to service', async () => {
    const usersService = {
      findAssignableDrivers: jest
        .fn()
        .mockResolvedValue([{ id: 'driver-1', name: 'Bruno Díaz' }]),
    };
    const controller = new UsersController(usersService as never);

    const result = await controller.findAssignableDrivers();

    expect(usersService.findAssignableDrivers).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: 'driver-1', name: 'Bruno Díaz' }]);
  });
});
