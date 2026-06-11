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
});
