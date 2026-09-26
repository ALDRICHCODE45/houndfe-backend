import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import {
  PrismaLoginOtpRepository,
  otpBucketKey,
} from '../infrastructure/prisma-login-otp.repository';
import { otpRateLimited } from '../login-otp.service';

export type LoginRateAction = 'login' | 'resend' | 'verify';
export const LOGIN_RATE_ACTION = 'auth:login-rate-action';
/** Apply with UseGuards(LoginRateLimitGuard) to each OTP02 route. */
export const LoginRateLimit = (action: LoginRateAction) =>
  SetMetadata(LOGIN_RATE_ACTION, action);

@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  constructor(
    private readonly repository: PrismaLoginOtpRepository,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<LoginRateAction>(
      LOGIN_RATE_ACTION,
      [context.getHandler(), context.getClass()],
    );
    if (!['login', 'resend', 'verify'].includes(action)) {
      throw new ServiceUnavailableException(
        'Authentication rate policy unavailable',
      );
    }
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    // There is no trusted-proxy configuration. Never read forwarded headers or req.ip.
    const source = request.socket.remoteAddress ?? 'unknown';
    await this.enforce(
      otpBucketKey(
        action === 'verify' ? 'source-verify' : 'source-login',
        source,
      ),
      action === 'verify' ? 60 : 30,
      http.getResponse<Response>(),
    );
    if (action === 'login') {
      const body = request.body as { email?: unknown } | undefined;
      const email =
        typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      await this.enforce(
        otpBucketKey('password-email', email),
        30,
        http.getResponse<Response>(),
      );
    }
    return true;
  }

  private async enforce(
    key: string,
    limit: number,
    response: Response,
  ): Promise<void> {
    let retryAfter: number;
    try {
      retryAfter = await this.repository.consumeRequestBudget(key, limit);
    } catch {
      throw new ServiceUnavailableException(
        'Autenticación temporalmente no disponible.',
      );
    }
    if (retryAfter) {
      response.setHeader('Retry-After', String(retryAfter));
      throw otpRateLimited(retryAfter);
    }
  }
}
