import {
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { MAILER, type IMailer } from '../notifications/email/mailer.port';
import {
  PrismaLoginOtpRepository,
  type OtpIdentity,
} from './infrastructure/prisma-login-otp.repository';
import { loginOtpTemplate } from './email/login-otp.template';

export type LoginOtpEnvelope = {
  requiresOtp: true;
  challengeId: string;
  expiresIn: 600;
  resendAfter: 60;
};

export function otpRateLimited(retryAfter: number): HttpException {
  return new HttpException(
    {
      statusCode: 429,
      error: 'Too Many Requests',
      code: 'OTP_RATE_LIMITED',
      message: 'Demasiados intentos. Intenta nuevamente más tarde.',
      retryAfter,
    },
    429,
  );
}

function invalidOtp(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    error: 'Unauthorized',
    code: 'OTP_INVALID',
    message: 'El código no es válido. Inicia sesión nuevamente.',
  });
}

function deliveryUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    code: 'OTP_DELIVERY_UNAVAILABLE',
    message: 'No se pudo enviar el código. Inicia sesión nuevamente.',
  });
}

@Injectable()
export class LoginOtpService {
  private readonly key: Buffer;

  constructor(
    private readonly repository: PrismaLoginOtpRepository,
    @Inject(MAILER) private readonly mailer: IMailer,
    config: ConfigService,
  ) {
    this.key = createHmac('sha256', config.getOrThrow<string>('JWT_SECRET'))
      .update('houndfe/password-login-otp/key/v1')
      .digest();
  }

  private hashHandle(handle: string): string {
    return createHash('sha256').update(handle).digest('hex');
  }

  private mac(
    userId: string,
    generation: string,
    handleHash: string,
    code: string,
  ): string {
    // JSON tuple avoids ambiguous concatenation; fixed-length digests are compared below.
    return createHmac('sha256', this.key)
      .update(
        JSON.stringify([
          'password-login-otp/v1',
          userId,
          generation,
          handleHash,
          code,
        ]),
      )
      .digest('hex');
  }

  /** Call only after password verification; this method never issues credentials. */
  issue(userId: string): Promise<LoginOtpEnvelope> {
    return this.deliver(userId);
  }

  async resend(challengeId: string): Promise<LoginOtpEnvelope> {
    if (!this.validHandle(challengeId)) throw invalidOtp();
    const handleHash = this.hashHandle(challengeId);
    const current = await this.database(() =>
      this.repository.findByHandle(handleHash),
    );
    if (!current) throw invalidOtp();
    return this.deliver(current.userId, handleHash);
  }

  private async deliver(
    userId: string,
    expectedHandleHash?: string,
  ): Promise<LoginOtpEnvelope> {
    const challengeId = randomBytes(32).toString('base64url');
    const generation = randomBytes(32).toString('base64url');
    const handleHash = this.hashHandle(challengeId);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const reservation = await this.database(() =>
      this.repository.reserve({
        userId,
        generation,
        handleHash,
        codeMac: this.mac(userId, generation, handleHash, code),
        expectedHandleHash,
      }),
    );
    if (reservation.kind === 'limited')
      throw otpRateLimited(reservation.retryAfter);
    if (reservation.kind === 'invalid') throw invalidOtp();
    try {
      await this.mailer.send({
        to: [reservation.email],
        ...loginOtpTemplate(code),
        sensitive: true,
      });
    } catch {
      await this.database(() =>
        this.repository.complete(userId, generation, false),
      );
      throw deliveryUnavailable();
    }
    const activated = await this.database(() =>
      this.repository.complete(userId, generation, true),
    );
    if (!activated) throw deliveryUnavailable();
    return { requiresOtp: true, challengeId, expiresIn: 600, resendAfter: 60 };
  }

  async verify(challengeId: string, code: string): Promise<OtpIdentity> {
    if (
      !this.validHandle(challengeId) ||
      typeof code !== 'string' ||
      !/^[0-9]{6}$/.test(code)
    ) {
      throw invalidOtp();
    }
    const handleHash = this.hashHandle(challengeId);
    const identity = await this.database(() =>
      this.repository.verify(handleHash, (challenge) => {
        const expected = Buffer.from(challenge.codeMac, 'hex');
        const actual = Buffer.from(
          this.mac(challenge.userId, challenge.generation, handleHash, code),
          'hex',
        );
        return expected.length === 32 && timingSafeEqual(expected, actual);
      }),
    );
    if (!identity) throw invalidOtp();
    return identity;
  }

  private validHandle(handle: string): boolean {
    return typeof handle === 'string' && /^[A-Za-z0-9_-]{43}$/.test(handle);
  }

  private async database<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      // Infrastructure faults are not invalid codes, and may contain query data.
      throw new ServiceUnavailableException(
        'Autenticación temporalmente no disponible.',
      );
    }
  }
}
