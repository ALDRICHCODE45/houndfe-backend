import { BadRequestException } from '@nestjs/common';
import {
  IsIn,
  IsString,
  ValidateNested,
  ValidationError,
} from 'class-validator';
import { Type } from 'class-transformer';
import { createAppValidationPipe } from './app-validation.pipe';
import { LoginDto } from '../../auth/dto/login.dto';
import { VerifyLoginOtpDto } from '../../auth/dto/verify-login-otp.dto';
import { ResendLoginOtpDto } from '../../auth/dto/resend-login-otp.dto';
import { createListingValidationExceptionFactory } from './listing-validation-exception.factory';

describe('createListingValidationExceptionFactory', () => {
  it('maps listing context errors to ListingHttpException envelope', () => {
    const factory = createListingValidationExceptionFactory();
    const error = new ValidationError();
    error.property = 'paymentStatus';
    error.contexts = {
      listingError: {
        code: 'LISTING_INVALID_ENUM_VALUE',
        field: 'paymentStatus',
        details: { allowed: ['PAID', 'PARTIAL', 'CREDIT'] },
      },
    };

    const exception = factory([error]);

    expect(exception.getStatus()).toBe(400);
    expect(exception.getResponse()).toEqual({
      statusCode: 400,
      code: 'LISTING_INVALID_ENUM_VALUE',
      message: 'paymentStatus is invalid',
      field: 'paymentStatus',
      details: { allowed: ['PAID', 'PARTIAL', 'CREDIT'] },
    });
  });

  it('falls back to BadRequestException when no listing context is present', () => {
    const factory = createListingValidationExceptionFactory();
    const error = new ValidationError();
    error.property = 'limit';
    error.constraints = { max: 'limit must not be greater than 100' };

    const exception = factory([error]);

    expect(exception).toBeInstanceOf(BadRequestException);
    expect(exception.getStatus()).toBe(400);
  });
});

class SecretChildDto {
  @IsString()
  password!: string;
}

class NestedSecretDto {
  @ValidateNested()
  @Type(() => SecretChildDto)
  child!: SecretChildDto;
}

class ListingStatusDto {
  @IsIn(['PAID'], {
    context: {
      code: 'LISTING_INVALID_ENUM_VALUE',
      field: 'paymentStatus',
      details: { allowed: ['PAID'] },
    },
  })
  paymentStatus!: string;
}

describe('createAppValidationPipe actual validation and redaction', () => {
  const challengeId = 'a'.repeat(43);

  it('transforms valid DTOs while preserving a zero-padded code as a string', async () => {
    const result: unknown = await createAppValidationPipe().transform(
      { challengeId, code: '000123' },
      { type: 'body', metatype: VerifyLoginOtpDto },
    );
    expect(result).toBeInstanceOf(VerifyLoginOtpDto);
    expect(result).toEqual({ challengeId, code: '000123' });
    await expect(
      createAppValidationPipe().transform(
        { challengeId },
        { type: 'body', metatype: ResendLoginOtpDto },
      ),
    ).resolves.toEqual({ challengeId });
  });

  it.each([
    123456,
    null,
    undefined,
    {},
    ['000123'],
    '12345',
    '1234567',
    '１２３４５６',
    '١٢٣٤٥٦',
    ' 00123',
    '00123\n',
  ])('rejects malformed code without coercion: %j', async (code) => {
    await expect(
      createAppValidationPipe().transform(
        { challengeId, code },
        { type: 'body', metatype: VerifyLoginOtpDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    123,
    null,
    undefined,
    {},
    ['a'.repeat(43)],
    '',
    'a'.repeat(42),
    'a'.repeat(44),
    '!'.repeat(43),
  ])('rejects malformed challenge: %j', async (handle) => {
    for (const metatype of [VerifyLoginOtpDto, ResendLoginOtpDto]) {
      const body =
        metatype === VerifyLoginOtpDto
          ? { challengeId: handle, code: '000123' }
          : { challengeId: handle };
      await expect(
        createAppValidationPipe().transform(body, { type: 'body', metatype }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it.each([
    [
      LoginDto,
      {
        email: 'test@example.com',
        password: { secret: 'submitted-password-marker' },
      },
    ],
    [
      LoginDto,
      {
        email: 'invalid-email-marker',
        password: 'submitted-password-marker',
        unknown: { nested: 'unknown-secret-marker' },
      },
    ],
    [VerifyLoginOtpDto, { challengeId, code: 'submitted-code-marker' }],
    [
      VerifyLoginOtpDto,
      {
        challengeId,
        code: '000123',
        unknown: { nested: 'unknown-secret-marker' },
      },
    ],
    [
      NestedSecretDto,
      {
        child: {
          password: { secret: 'nested-password-marker' },
          unknown: ['nested-value-marker'],
        },
      },
    ],
  ] as const)(
    'redacts target/value recursively for %p',
    async (metatype, body) => {
      let failure: unknown;
      try {
        await createAppValidationPipe().transform(body, {
          type: 'body',
          metatype,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(BadRequestException);
      const exception = failure as BadRequestException;
      expect(exception.getStatus()).toBe(400);
      const response = exception.getResponse() as {
        statusCode: number;
        error: string;
        message: ValidationError[];
      };
      expect(response).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(Array.isArray(response.message)).toBe(true);
      const check = (errors: ValidationError[]) => {
        for (const error of errors) {
          expect(error).not.toHaveProperty('target');
          expect(error).not.toHaveProperty('value');
          check(error.children ?? []);
        }
      };
      check(response.message);
      const serialized = JSON.stringify(response);
      for (const marker of [
        'submitted-password-marker',
        'invalid-email-marker',
        'unknown-secret-marker',
        'submitted-code-marker',
        'nested-password-marker',
        'nested-value-marker',
        '000123',
        challengeId,
      ]) {
        expect(serialized).not.toContain(marker);
      }
    },
  );

  it('retains listing-specific error context and the ordinary 400 contract', async () => {
    try {
      await createAppValidationPipe().transform(
        { paymentStatus: 'INVALID' },
        { type: 'query', metatype: ListingStatusDto },
      );
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        statusCode: 400,
        code: 'LISTING_INVALID_ENUM_VALUE',
        field: 'paymentStatus',
        details: { allowed: ['PAID'] },
      });
    }
  });
});
