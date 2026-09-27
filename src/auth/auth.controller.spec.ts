import 'reflect-metadata';
import {
  HttpException,
  RequestMethod,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import type { Response } from 'express';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import {
  LOGIN_RATE_ACTION,
  LoginRateLimitGuard,
} from './guards/login-rate-limit.guard';
import { otpRateLimited } from './login-otp.service';

const setup = () => {
  const service = {
    login: jest.fn(),
    verifyLoginOtp: jest.fn(),
    resendLoginOtp: jest.fn(),
    register: jest.fn(),
  };
  const setHeader = jest.fn();
  const response = { setHeader } as unknown as Response;
  return {
    service,
    response,
    setHeader,
    controller: new AuthController(service as unknown as AuthService),
  };
};

describe('AuthController OTP boundary', () => {
  it.each([
    ['login', 'login', 'login'],
    ['verifyLoginOtp', 'login/otp/verify', 'verify'],
    ['resendLoginOtp', 'login/otp/resend', 'resend'],
  ] as const)(
    'protects %s with the correct rate policy and HTTP 200',
    (name, path, action) => {
      const handler = AuthController.prototype[name];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        RequestMethod.POST,
      );
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
      expect(Reflect.getMetadata(LOGIN_RATE_ACTION, handler)).toBe(action);
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
        LoginRateLimitGuard,
      );
    },
  );

  it.each(['login', 'verifyLoginOtp', 'resendLoginOtp'] as const)(
    'delegates %s without changing success or errors',
    async (name) => {
      const { controller, service, response, setHeader } = setup();
      const dto = {
        email: 'test@example.com',
        password: 'synthetic-password',
        challengeId: 'a'.repeat(43),
        code: '000123',
      };
      const result = {
        requiresOtp: true,
        challengeId: 'b'.repeat(43),
        expiresIn: 600,
        resendAfter: 60,
      };
      service[name].mockResolvedValue(result);
      await expect(controller[name](dto, response)).resolves.toBe(result);
      expect(service[name]).toHaveBeenCalledWith(dto);
      expect(setHeader).not.toHaveBeenCalled();
      const error = otpRateLimited(47);
      service[name].mockRejectedValue(error);
      await expect(controller[name](dto, response)).rejects.toBe(error);
      expect(setHeader).toHaveBeenCalledWith('Retry-After', '47');
      expect(error.getResponse()).toMatchObject({
        code: 'OTP_RATE_LIMITED',
        retryAfter: 47,
      });
    },
  );

  it.each([
    new UnauthorizedException({
      statusCode: 401,
      error: 'Unauthorized',
      code: 'OTP_INVALID',
      message: 'invalid',
    }),
    new ServiceUnavailableException({
      statusCode: 503,
      error: 'Service Unavailable',
      code: 'OTP_DELIVERY_UNAVAILABLE',
      message: 'unavailable',
    }),
    new HttpException({ retryAfter: 'not-a-number' }, 429),
  ])(
    'preserves generic exception bodies without injecting headers',
    async (error) => {
      const { controller, service, response, setHeader } = setup();
      service.verifyLoginOtp.mockRejectedValue(error);
      await expect(
        controller.verifyLoginOtp(
          { challengeId: 'a'.repeat(43), code: '000123' },
          response,
        ),
      ).rejects.toBe(error);
      expect(setHeader).not.toHaveBeenCalled();
    },
  );

  it('registration remains HTTP 201 and returns only service creation data', async () => {
    const { controller, service } = setup();
    const created = { user: { id: 'user-1' } };
    service.register.mockResolvedValue(created);
    await expect(
      controller.register({
        name: 'Test',
        email: 'test@example.com',
        password: 'synthetic-password',
      }),
    ).resolves.toBe(created);
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        Reflect.get(AuthController.prototype, 'register') as object,
      ),
    ).toBe(201);
  });
});
