import { ConfigService } from '@nestjs/config';
import { LoginOtpService } from './login-otp.service';
import { PrismaLoginOtpRepository } from './infrastructure/prisma-login-otp.repository';
import type { SendMailInput } from '../notifications/email/mailer.port';
import type { LoginOtpChallenge } from '@prisma/client';
import { createHmac } from 'node:crypto';

// Only code generation is deterministic; hashing/HMAC/comparison stay real.
jest.mock('node:crypto', () => {
  const actual =
    jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, randomInt: jest.fn(() => 1) };
});

function setup() {
  const repo = {
    reserve: jest
      .fn<
        ReturnType<PrismaLoginOtpRepository['reserve']>,
        Parameters<PrismaLoginOtpRepository['reserve']>
      >()
      .mockResolvedValue({ kind: 'ok', email: 'fake@example.test' }),
    complete: jest.fn().mockResolvedValue(true),
    findByHandle: jest.fn().mockResolvedValue({ userId: 'user' }),
    verify: jest.fn<
      ReturnType<PrismaLoginOtpRepository['verify']>,
      Parameters<PrismaLoginOtpRepository['verify']>
    >(),
  };
  const send = jest.fn<Promise<void>, [SendMailInput]>().mockResolvedValue();
  const service = new LoginOtpService(
    repo as unknown as PrismaLoginOtpRepository,
    { send },
    new ConfigService({ JWT_SECRET: 'fake-test-secret' }),
  );
  return { service, repo, send };
}

describe('LoginOtpService', () => {
  it('issues only an opaque envelope and persists hashes, never the code', async () => {
    const { service, repo, send } = setup();
    const result = await service.issue('user');
    expect(result).toEqual({
      requiresOtp: true,
      challengeId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string,
      expiresIn: 600,
      resendAfter: 60,
    });
    const input = send.mock.calls[0][0];
    expect(input.sensitive).toBe(true);
    expect(input.html).toMatch(/\b[0-9]{6}\b/);
    const saved = repo.reserve.mock.calls[0] as unknown[];
    expect(JSON.stringify(saved)).not.toContain(result.challengeId);
    expect(saved).toEqual([
      expect.objectContaining({
        userId: 'user',
        handleHash: expect.stringMatching(/^[a-f0-9]{64}$/) as string,
        createCodeMac: expect.any(Function) as unknown,
      }),
    ]);
  });

  it.each([
    'matching',
    'code',
    'handle',
    'generation',
    'user',
    'email',
    'digest',
    'legacy',
  ])(
    'executes the real cryptographic callback against %s input',
    async (variant) => {
      const { service, repo, send } = setup();
      const envelope = await service.issue('user');
      const reservation = repo.reserve.mock.calls[0][0];
      const stored: LoginOtpChallenge = {
        userId: reservation.userId,
        generation: reservation.generation,
        handleHash: reservation.handleHash,
        codeMac: reservation.createCodeMac({
          id: 'user',
          email: 'fake@example.test',
        }),
        state: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        consumedAt: null,
      };
      expect(send.mock.calls[0][0].html).toContain('<strong>000001</strong>');
      expect(JSON.stringify(reservation)).not.toContain('"000001"');
      if (variant === 'generation') stored.generation += '-tampered';
      if (variant === 'user') stored.userId = 'other-user';
      if (variant === 'digest') stored.codeMac = 'invalid-digest';
      if (variant === 'legacy') {
        const key = createHmac('sha256', 'fake-test-secret')
          .update('houndfe/password-login-otp/key/v1')
          .digest();
        stored.codeMac = createHmac('sha256', key)
          .update(
            JSON.stringify([
              'password-login-otp/v1',
              stored.userId,
              stored.generation,
              stored.handleHash,
              '000001',
            ]),
          )
          .digest('hex');
      }
      const identity = {
        id: 'user',
        email:
          variant === 'email' ? 'changed@example.test' : 'fake@example.test',
      };
      repo.verify.mockImplementation((_hash, matches) =>
        Promise.resolve(matches(stored, identity) ? identity : null),
      );
      const wrongHandle = `${envelope.challengeId[0] === 'A' ? 'B' : 'A'}${envelope.challengeId.slice(1)}`;
      const verification = service.verify(
        variant === 'handle' ? wrongHandle : envelope.challengeId,
        variant === 'code' ? '000002' : '000001',
      );
      if (variant === 'matching')
        await expect(verification).resolves.toEqual(identity);
      else
        await expect(verification).rejects.toMatchObject({
          response: { statusCode: 401, code: 'OTP_INVALID' },
        });
      expect(repo.verify).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['failure', 'stale'])(
    'never returns an envelope on %s delivery',
    async (mode) => {
      const { service, repo, send } = setup();
      if (mode === 'failure') send.mockRejectedValue(new Error('secret code'));
      else repo.complete.mockResolvedValue(false);
      await expect(service.issue('user')).rejects.toMatchObject({
        response: {
          statusCode: 503,
          code: 'OTP_DELIVERY_UNAVAILABLE',
          error: 'Service Unavailable',
        },
      });
      if (mode === 'failure')
        expect(repo.complete).toHaveBeenCalledWith(
          'user',
          expect.any(String),
          false,
        );
    },
  );

  it('preserves challenges on issuance limits without sending', async () => {
    const { service, repo, send } = setup();
    repo.reserve.mockResolvedValue({ kind: 'limited', retryAfter: 60 });
    await expect(service.resend('a'.repeat(43))).rejects.toMatchObject({
      response: { code: 'OTP_RATE_LIMITED', retryAfter: 60, statusCode: 429 },
    });
    expect(send).not.toHaveBeenCalled();
    expect(repo.complete).not.toHaveBeenCalled();
  });

  it('returns only consumed identity and rejects invalid outcomes generically', async () => {
    const { service, repo } = setup();
    repo.verify.mockResolvedValue({ id: 'user', email: 'fake@example.test' });
    await expect(service.verify('a'.repeat(43), '000001')).resolves.toEqual({
      id: 'user',
      email: 'fake@example.test',
    });
    repo.verify.mockResolvedValue(null);
    await expect(
      service.verify('a'.repeat(43), '000001'),
    ).rejects.toMatchObject({
      response: { statusCode: 401, code: 'OTP_INVALID' },
    });
  });

  it('rejects non-ASCII, numeric and malformed codes', async () => {
    const { service, repo } = setup();
    for (const code of [
      '１２３４５６',
      '12345',
      '1234567',
      ' 123456',
      123456,
    ]) {
      await expect(
        service.verify('a'.repeat(43), code as string),
      ).rejects.toMatchObject({ response: { code: 'OTP_INVALID' } });
    }
    expect(repo.verify).not.toHaveBeenCalled();
  });

  it('does not mask database faults as invalid OTP or leak details', async () => {
    const { service, repo } = setup();
    repo.verify.mockRejectedValue(new Error('database secret'));
    await expect(
      service.verify('a'.repeat(43), '000001'),
    ).rejects.toMatchObject({
      status: 503,
    });
  });
});
