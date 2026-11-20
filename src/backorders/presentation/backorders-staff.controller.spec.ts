/* eslint-disable @typescript-eslint/unbound-method -- the jest.fn() response stub is asserted, not called detached */
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import type { BackordersStaffService } from '../application/backorders-staff.service';
import { BackorderError } from '../domain/backorder-error';
import { BackordersStaffController } from './backorders-staff.controller';

const ID = '3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f';
const USER: AuthenticatedUser = {
  userId: 'user-1',
  email: 'ana@houndfe.com',
  tenantId: 'tenant-1',
  tenantSlug: 'centro',
  isSuperAdmin: false,
};

function setup() {
  const service = {
    list: jest.fn(() => Promise.resolve({ items: [] })),
    findById: jest.fn(() => Promise.resolve({ id: ID })),
    cancel: jest.fn(() => Promise.resolve({ id: ID })),
  };
  const controller = new BackordersStaffController(
    service as unknown as BackordersStaffService,
  );
  const response = { setHeader: jest.fn() } as unknown as Response;
  return { controller, service, response };
}

const failure = async (work: () => Promise<unknown>) => {
  try {
    await work();
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a rejection');
};

describe('BackordersStaffController', () => {
  it('chains JwtAuthGuard → TenantContextGuard → PermissionsGuard on the class', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, BackordersStaffController),
    ).toEqual([JwtAuthGuard, TenantContextGuard, PermissionsGuard]);
  });

  it.each([
    ['list', [['read', 'Backorder']]],
    ['findOne', [['read', 'Backorder']]],
    ['cancel', [['update', 'Backorder']]],
  ])('%s requires %j', (method, expected) => {
    const handler = BackordersStaffController.prototype[
      method as 'list' | 'findOne' | 'cancel'
    ] as object;
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(expected);
  });

  it('list parses the query, serves it from the service and never caches', async () => {
    const { controller, service, response } = setup();
    await controller.list({ status: 'WAITING', page: '2' }, response);
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, statuses: ['WAITING'], limit: 20 }),
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
  });

  it('list answers 400 INVALID_BACKORDER_REQUEST for a bad query', async () => {
    const { controller, service, response } = setup();
    const error = await failure(() => controller.list({ page: '0' }, response));
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({
      statusCode: 400,
      error: 'INVALID_BACKORDER_REQUEST',
      message: 'INVALID_BACKORDER_REQUEST',
    });
    expect(service.list).not.toHaveBeenCalled();
  });

  it('findOne answers 404 BACKORDER_NOT_FOUND for a malformed id without touching the service', async () => {
    const { controller, service, response } = setup();
    const error = await failure(() => controller.findOne('nope', response));
    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toEqual({
      statusCode: 404,
      error: 'BACKORDER_NOT_FOUND',
      message: 'BACKORDER_NOT_FOUND',
    });
    expect(service.findById).not.toHaveBeenCalled();
  });

  it('findOne returns the staff projection', async () => {
    const { controller, service, response } = setup();
    await expect(controller.findOne(ID, response)).resolves.toEqual({ id: ID });
    expect(service.findById).toHaveBeenCalledWith(ID);
  });

  it('cancel forwards the parsed body and the actor from the verified user only', async () => {
    const { controller, service, response } = setup();
    await controller.cancel(
      ID,
      { reason: ' Sin respuesta ', version: 4 },
      USER,
      response,
    );
    expect(service.cancel).toHaveBeenCalledWith(
      ID,
      { reason: 'Sin respuesta', version: 4 },
      'user-1',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
  });

  it('cancel answers 400 for a body without version and 404 for a malformed id', async () => {
    const { controller, service, response } = setup();
    const noVersion = await failure(() =>
      controller.cancel(ID, { reason: 'x' }, USER, response),
    );
    expect(noVersion.getStatus()).toBe(400);
    const badId = await failure(() =>
      controller.cancel('nope', { version: 1 }, USER, response),
    );
    expect(badId.getStatus()).toBe(404);
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it('cancel keeps the contract status and detail of the service errors', async () => {
    const { controller, service, response } = setup();
    service.cancel.mockRejectedValueOnce(
      new BackorderError('VERSION_CONFLICT', { currentVersion: 7 }),
    );
    const conflict = await failure(() =>
      controller.cancel(ID, { version: 1 }, USER, response),
    );
    expect(conflict.getStatus()).toBe(409);
    expect(conflict.getResponse()).toEqual({
      statusCode: 409,
      error: 'VERSION_CONFLICT',
      message: 'VERSION_CONFLICT',
      currentVersion: 7,
    });
    service.cancel.mockRejectedValueOnce(
      new BackorderError('BACKORDER_NOT_CANCELLABLE', { status: 'CONFIRMED' }),
    );
    const terminal = await failure(() =>
      controller.cancel(ID, { version: 1 }, USER, response),
    );
    expect(terminal.getResponse()).toEqual({
      statusCode: 409,
      error: 'BACKORDER_NOT_CANCELLABLE',
      message: 'BACKORDER_NOT_CANCELLABLE',
      status: 'CONFIRMED',
    });
  });
});
