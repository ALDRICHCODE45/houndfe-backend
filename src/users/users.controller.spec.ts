import { UsersController } from './users.controller';

describe('UsersController', () => {
  it('delegates assignable listing to service', async () => {
    const usersService = {
      findAssignable: jest.fn().mockResolvedValue([
        { id: 'u-1', name: 'Ana Pérez' },
      ]),
    };
    const controller = new UsersController(usersService as never);

    const result = await controller.findAssignable();

    expect(usersService.findAssignable).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: 'u-1', name: 'Ana Pérez' }]);
  });
});
