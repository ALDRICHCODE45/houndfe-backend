import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AuthModule } from './auth.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginOtpService } from './login-otp.service';
import { LoginRateLimitGuard } from './guards/login-rate-limit.guard';
import { PrismaLoginOtpRepository } from './infrastructure/prisma-login-otp.repository';
import { MailerModule } from '../notifications/email/mailer.module';
import { MAILER } from '../notifications/email/mailer.port';
import { PrismaService } from '../shared/prisma/prisma.service';
import { USER_REPOSITORY } from './domain/user.repository';
import { CaslAbilityFactory } from './authorization/casl-ability.factory';

describe('AuthModule OTP wiring', () => {
  it('imports the exported mailer and registers OTP providers and controller', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AuthModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      AuthModule,
    ) as unknown[];
    expect(imports).toContain(MailerModule);
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, MailerModule),
    ).toContain(MAILER);
    expect(providers).toEqual(
      expect.arrayContaining([
        AuthService,
        LoginOtpService,
        PrismaLoginOtpRepository,
        LoginRateLimitGuard,
      ]),
    );
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AuthModule),
    ).toContain(AuthController);
  });

  it('resolves the OTP graph with only mock infrastructure, without app bootstrap', async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService,
        LoginOtpService,
        LoginRateLimitGuard,
        PrismaLoginOtpRepository,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('synthetic-test-key'),
          },
        },
        { provide: JwtService, useValue: { signAsync: jest.fn() } },
        { provide: USER_REPOSITORY, useValue: {} },
        { provide: CaslAbilityFactory, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: MAILER, useValue: { send: jest.fn() } },
      ],
    }).compile();
    expect(module.get(AuthController)).toBeInstanceOf(AuthController);
    expect(module.get(LoginOtpService)).toBeInstanceOf(LoginOtpService);
    expect(module.get(LoginRateLimitGuard)).toBeInstanceOf(LoginRateLimitGuard);
    await module.close();
  });
});
