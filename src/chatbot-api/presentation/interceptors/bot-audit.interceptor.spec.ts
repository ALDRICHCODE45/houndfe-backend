import {
  CallHandler,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import type { ServiceCredential } from '../../domain/service-credential.entity';
import { BotAuditInterceptor } from './bot-audit.interceptor';

function makeCredential(): Pick<ServiceCredential, 'id' | 'tenantId'> {
  return {
    id: 'cred-1',
    tenantId: 'tenant-1',
  };
}

describe('BotAuditInterceptor', () => {
  function makeContext(input?: {
    method?: string;
    routePath?: string;
    params?: Record<string, string>;
    statusCode?: number;
    credential?: Pick<ServiceCredential, 'id' | 'tenantId'> | undefined;
  }): ExecutionContext {
    const request = {
      method: input?.method ?? 'POST',
      route: {
        path: input?.routePath ?? '/chatbot-api/sales/:saleId/receipts',
      },
      params: input?.params ?? { saleId: 'sale-1' },
      serviceCredential: input?.credential ?? makeCredential(),
    };

    const response = {
      statusCode: input?.statusCode ?? 201,
    };

    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as ExecutionContext;
  }

  it('writes an audit row after a successful chatbot response', async () => {
    const repository = { append: jest.fn().mockResolvedValue(undefined) };
    const interceptor = new BotAuditInterceptor(repository);

    await expect(
      lastValueFrom(
        interceptor.intercept(makeContext(), {
          handle: () => of({ receiptId: 'receipt-1' }),
        } as CallHandler),
      ),
    ).resolves.toEqual({ receiptId: 'receipt-1' });

    expect(repository.append).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      credentialId: 'cred-1',
      action: 'sales.attach_receipt',
      resourceType: 'sale',
      resourceId: 'sale-1',
      metadata: {
        branchId: 'tenant-1',
        httpMethod: 'POST',
        routePath: '/chatbot-api/sales/:saleId/receipts',
        statusCode: 201,
        outcome: 'success',
      },
    });
  });

  it('still writes an audit row when the chatbot route fails', async () => {
    const repository = { append: jest.fn().mockResolvedValue(undefined) };
    const interceptor = new BotAuditInterceptor(repository);

    await expect(
      lastValueFrom(
        interceptor.intercept(makeContext({ statusCode: 500 }), {
          handle: () =>
            throwError(
              () =>
                new InternalServerErrorException('receipt processing failed'),
            ),
        } as CallHandler),
      ),
    ).rejects.toThrow(InternalServerErrorException);

    expect(repository.append).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      credentialId: 'cred-1',
      action: 'sales.attach_receipt',
      resourceType: 'sale',
      resourceId: 'sale-1',
      metadata: {
        branchId: 'tenant-1',
        httpMethod: 'POST',
        routePath: '/chatbot-api/sales/:saleId/receipts',
        statusCode: 500,
        outcome: 'error',
        errorMessage: 'receipt processing failed',
      },
    });
  });

  // customer-pets / T2: every pet bot route is on the allowlist.
  it.each([
    [
      'GET',
      '/chatbot-api/customers/:customerId/pets',
      'customer_pets.list',
      'customer',
      'customerId',
      'c-1',
    ],
    [
      'POST',
      '/chatbot-api/customers/:customerId/pets',
      'customer_pets.create',
      'customer',
      'customerId',
      'c-1',
    ],
    [
      'PATCH',
      '/chatbot-api/customers/:customerId/pets/:petId',
      'customer_pets.update',
      'customer_pet',
      'petId',
      'p-1',
    ],
    [
      'POST',
      '/chatbot-api/customers/:customerId/pets/:petId/archive',
      'customer_pets.archive',
      'customer_pet',
      'petId',
      'p-1',
    ],
    [
      'POST',
      '/chatbot-api/customers/:customerId/pets/:petId/restore',
      'customer_pets.restore',
      'customer_pet',
      'petId',
      'p-1',
    ],
    [
      'DELETE',
      '/chatbot-api/customers/:customerId/pets/:petId',
      'customer_pets.delete',
      'customer_pet',
      'petId',
      'p-1',
    ],
  ])(
    'audits %s %s as %s',
    async (method, routePath, action, resourceType, idParam, resourceId) => {
      const repository = { append: jest.fn().mockResolvedValue(undefined) };
      const interceptor = new BotAuditInterceptor(repository);

      await lastValueFrom(
        interceptor.intercept(
          makeContext({
            method,
            routePath,
            params: { customerId: 'c-1', petId: 'p-1' },
            statusCode: 200,
          }),
          { handle: () => of({}) } as CallHandler,
        ),
      );

      expect(idParam).toBeDefined();
      expect(repository.append).toHaveBeenCalledTimes(1);
      expect(repository.append).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        credentialId: 'cred-1',
        action,
        resourceType,
        resourceId,
        metadata: {
          branchId: 'tenant-1',
          httpMethod: method,
          routePath,
          statusCode: 200,
          outcome: 'success',
        },
      });
    },
  );
});
