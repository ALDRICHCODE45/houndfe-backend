import { SaleCommentsController } from './sale-comments.controller';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

describe('SaleCommentsController', () => {
  const makeUser = (userId: string): AuthenticatedUser => ({
    userId,
    email: `${userId}@example.com`,
    tenantId: null,
    tenantSlug: null,
    isSuperAdmin: false,
  });

  it('delegates create to service', async () => {
    const service = { create: jest.fn(), update: jest.fn(), softDelete: jest.fn() };
    const controller = new SaleCommentsController(service as any);

    service.create.mockResolvedValue({ id: 'c1' });
    const result = await controller.create('sale-1', { body: 'hello' }, makeUser('u1'));

    expect(result).toEqual({ id: 'c1' });
    expect(service.create).toHaveBeenCalledWith('sale-1', 'u1', { body: 'hello' });
  });

  it('delegates update to service', async () => {
    const service = { create: jest.fn(), update: jest.fn(), softDelete: jest.fn() };
    const controller = new SaleCommentsController(service as any);

    await controller.update('sale-1', 'comment-1', { body: 'updated' }, makeUser('u1'));

    expect(service.update).toHaveBeenCalledWith('sale-1', 'comment-1', 'u1', {
      body: 'updated',
    });
  });

  it('delegates soft-delete to service', async () => {
    const service = { create: jest.fn(), update: jest.fn(), softDelete: jest.fn() };
    const controller = new SaleCommentsController(service as any);

    await controller.softDelete('sale-1', 'comment-1', makeUser('u1'));

    expect(service.softDelete).toHaveBeenCalledWith('sale-1', 'comment-1', 'u1');
  });

  it('forwards service errors on update', async () => {
    const service = { create: jest.fn(), update: jest.fn(), softDelete: jest.fn() };
    const controller = new SaleCommentsController(service as any);
    const error = new Error('boom');
    service.update.mockRejectedValue(error);

    await expect(
      controller.update('sale-1', 'comment-1', { body: 'updated' }, makeUser('u1')),
    ).rejects.toThrow(error);
  });
});
