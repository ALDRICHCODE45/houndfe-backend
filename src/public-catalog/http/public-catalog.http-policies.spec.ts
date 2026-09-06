import { CacheControlInterceptor } from './interceptors/cache-control.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';

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

  // F2.WU7 Slice 4 — the header must be assigned before downstream
  // handling so validation/resolver/use-case errors after the guards
  // still retain `no-store` (guard/throttler errors are not covered).
  it('assigns the header before downstream handling so downstream errors retain it', () => {
    reflector.get.mockReturnValue('no-store');
    const { ctx, setHeader } = mockContext();
    const downstream: CallHandler = {
      // Header must already be set when the downstream handler executes.
      handle: () =>
        new Observable((subscriber) => {
          expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
          subscriber.error(new Error('downstream'));
        }),
    };

    interceptor
      .intercept(ctx, downstream)
      .subscribe({ error: () => undefined });
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});
