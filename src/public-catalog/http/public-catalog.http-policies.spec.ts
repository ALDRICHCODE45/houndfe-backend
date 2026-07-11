import { CacheControlInterceptor } from './interceptors/cache-control.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';

describe('CacheControlInterceptor', () => {
  let interceptor: CacheControlInterceptor;
  let reflector: { get: jest.Mock };

  beforeEach(() => {
    reflector = { get: jest.fn() };
    interceptor = new CacheControlInterceptor(
      reflector as unknown as Reflector,
    );
  });

  function mockContext(): { ctx: ExecutionContext; setHeader: jest.Mock } {
    const setHeader = jest.fn();
    const ctx = {
      getHandler: () => ({}),
      switchToHttp: () => ({
        getResponse: () => ({ setHeader }),
      }),
    } as unknown as ExecutionContext;
    return { ctx, setHeader };
  }

  function mockCallHandler(): CallHandler {
    return { handle: () => of({ data: 'test' }) };
  }

  it('should set Cache-Control header from decorator metadata', (done) => {
    reflector.get.mockReturnValue('public, max-age=300');
    const { ctx, setHeader } = mockContext();

    interceptor.intercept(ctx, mockCallHandler()).subscribe({
      next: () => {
        expect(setHeader).toHaveBeenCalledWith(
          'Cache-Control',
          'public, max-age=300',
        );
        done();
      },
    });
  });

  it('should not set header when no metadata is present', (done) => {
    reflector.get.mockReturnValue(undefined);
    const { ctx, setHeader } = mockContext();

    interceptor.intercept(ctx, mockCallHandler()).subscribe({
      next: () => {
        expect(setHeader).not.toHaveBeenCalled();
        done();
      },
    });
  });

  it('should set no-store for cart validate', (done) => {
    reflector.get.mockReturnValue('no-store');
    const { ctx, setHeader } = mockContext();

    interceptor.intercept(ctx, mockCallHandler()).subscribe({
      next: () => {
        expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
        done();
      },
    });
  });
});
