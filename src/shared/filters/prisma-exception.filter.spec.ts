import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaExceptionFilter } from './prisma-exception.filter';

describe('PrismaExceptionFilter', () => {
  const makeHost = (path = '/promotions') => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url: path }),
      }),
    } as any;
    return { host, status, json };
  };

  const makeError = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('prisma error', {
      code,
      clientVersion: Prisma.prismaVersion.client,
    });

  it.each([
    ['P2025', HttpStatus.NOT_FOUND, 'Resource not found'],
    ['P2002', HttpStatus.CONFLICT, 'Unique constraint violation'],
    ['P2003', HttpStatus.BAD_REQUEST, 'Invalid relation reference'],
    ['P9999', HttpStatus.INTERNAL_SERVER_ERROR, 'Internal server error'],
  ])('maps %s to %s', (code, expectedStatus, expectedMessage) => {
    const filter = new PrismaExceptionFilter();
    const { host, status, json } = makeHost('/api/promotions');

    filter.catch(makeError(code), host);

    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: expectedStatus,
        message: expectedMessage,
        path: '/api/promotions',
        timestamp: expect.any(String),
      }),
    );
  });
});
