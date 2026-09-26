import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LoginRateLimitGuard } from './login-rate-limit.guard';
import {
  PrismaLoginOtpRepository,
  otpBucketKey,
} from '../infrastructure/prisma-login-otp.repository';

function setup(action: string | undefined = 'login') {
  const consumeRequestBudget = jest.fn().mockResolvedValue(0);
  const setHeader = jest.fn();
  const request = {
    socket: { remoteAddress: '192.0.2.1' },
    headers: { 'x-forwarded-for': '198.51.100.1' },
    body: { email: ' Unknown@Example.test ' },
  };
  const context = {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
  const guard = new LoginRateLimitGuard(
    { consumeRequestBudget } as unknown as PrismaLoginOtpRepository,
    { getAllAndOverride: () => action } as unknown as Reflector,
  );
  return { guard, context, consumeRequestBudget, setHeader, request };
}

describe('LoginRateLimitGuard (inert until route wiring)', () => {
  it('hashes normalized unknown email and uses only socket source', async () => {
    const { guard, context, consumeRequestBudget } = setup();
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(consumeRequestBudget.mock.calls).toEqual([
      [otpBucketKey('source-login', '192.0.2.1'), 30],
      [otpBucketKey('password-email', 'unknown@example.test'), 30],
    ]);
    expect(JSON.stringify(consumeRequestBudget.mock.calls)).not.toContain('@');
  });

  it.each(['resend', 'verify'])(
    'uses correct source complement for %s',
    async (action) => {
      const { guard, context, consumeRequestBudget } = setup(action);
      await guard.canActivate(context);
      expect(consumeRequestBudget.mock.calls).toEqual([
        [
          otpBucketKey(
            action === 'verify' ? 'source-verify' : 'source-login',
            '192.0.2.1',
          ),
          action === 'verify' ? 60 : 30,
        ],
      ]);
    },
  );

  it('returns bounded retry-after without reaching password work', async () => {
    const { guard, context, consumeRequestBudget, setHeader } = setup();
    consumeRequestBudget.mockResolvedValue(899);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { statusCode: 429, code: 'OTP_RATE_LIMITED', retryAfter: 899 },
    });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '899');
    expect(consumeRequestBudget).toHaveBeenCalledTimes(1);
  });

  it('fails closed for missing metadata and database faults', async () => {
    const missing = setup('');
    await expect(
      missing.guard.canActivate(missing.context),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(missing.consumeRequestBudget).not.toHaveBeenCalled();
    const broken = setup();
    broken.consumeRequestBudget.mockRejectedValue(new Error('database secret'));
    await expect(
      broken.guard.canActivate(broken.context),
    ).rejects.toMatchObject({
      status: 503,
    });
  });
});
