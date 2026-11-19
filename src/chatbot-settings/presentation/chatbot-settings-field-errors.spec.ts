/**
 * S11: shape errors of the real DTOs through the real global pipe, mapped to
 * `{path, code}` by the settings filter helpers (no HTTP needed).
 */
import { BadRequestException } from '@nestjs/common';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { defaultSettings } from '../domain/chatbot-attention-settings';
import {
  fieldErrorsOfValidation,
  validationErrorsOf,
} from './chatbot-settings-field-errors';
import { ApplyToAllDto, PutChatbotSettingsDto } from './chatbot-settings.dto';

const body = (): Record<string, unknown> => ({
  ...(JSON.parse(JSON.stringify(defaultSettings())) as object),
  expectedVersion: 0,
});

async function fieldErrors(
  type: new () => object,
  payload: Record<string, unknown>,
) {
  try {
    await createAppValidationPipe().transform(payload, {
      type: 'body',
      metatype: type,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const list = validationErrorsOf(
      (error as BadRequestException).getResponse(),
    );
    expect(list).not.toBeNull();
    return fieldErrorsOfValidation(list!, payload);
  }
  throw new Error('accepted');
}

describe('fieldErrorsOfValidation', () => {
  it('accepts a full valid body (nothing to map)', async () => {
    await expect(
      createAppValidationPipe().transform(body(), {
        type: 'body',
        metatype: PutChatbotSettingsDto,
      }),
    ).resolves.toBeDefined();
  });

  it.each<[string, (b: Record<string, unknown>) => void, object[]]>([
    [
      'a time that is not HH:mm',
      (b) => {
        const days = (b.openingHours as { days: Array<{ ranges: unknown[] }> })
          .days;
        days[1].ranges = [{ open: '9:00', close: '10:00' }];
      },
      [{ path: 'openingHours.days[1].ranges[0].open', code: 'INVALID_TIME' }],
    ],
    [
      'a missing close',
      (b) => {
        const days = (b.openingHours as { days: Array<{ ranges: unknown[] }> })
          .days;
        days[0].ranges = [{ open: '09:00' }];
      },
      [{ path: 'openingHours.days[0].ranges[0].close', code: 'REQUIRED' }],
    ],
    [
      'an unknown day name',
      (b) => {
        (b.openingHours as { days: Array<{ day: string }> }).days[2].day = 'X';
      },
      [{ path: 'openingHours.days[2].day', code: 'INVALID_VALUE' }],
    ],
    [
      'more than 6 ranges',
      (b) => {
        (
          b.openingHours as { days: Array<{ ranges: unknown[] }> }
        ).days[4].ranges = Array.from({ length: 7 }, () => ({
          open: '09:00',
          close: '10:00',
        }));
      },
      [{ path: 'openingHours.days[4].ranges', code: 'TOO_MANY_RANGES' }],
    ],
    [
      'a non-string closed date',
      (b) => {
        b.closedDates = ['2026-12-25', 5];
      },
      [{ path: 'closedDates[1]', code: 'INVALID_TYPE' }],
    ],
    [
      'a reasons value that is not an object',
      (b) => {
        b.closedDateReasons = 'x';
      },
      [{ path: 'closedDateReasons', code: 'INVALID_TYPE' }],
    ],
    [
      'a mistyped nested scheduling field',
      (b) => {
        (b.scheduling as { enabled: unknown }).enabled = 'yes';
      },
      [{ path: 'scheduling.enabled', code: 'INVALID_TYPE' }],
    ],
    [
      'a null where a string is required',
      (b) => {
        b.templateCostText = null;
      },
      [{ path: 'templateCostText', code: 'REQUIRED' }],
    ],
    [
      'an unknown subtype in enabledSubtypes',
      (b) => {
        b.enabledSubtypes = ['RESTOCK', 'NOPE'];
      },
      [{ path: 'enabledSubtypes[1]', code: 'INVALID_VALUE' }],
    ],
  ])('%s', async (_label, mutate, expected) => {
    const payload = body();
    mutate(payload);
    expect(await fieldErrors(PutChatbotSettingsDto, payload)).toEqual(expected);
  });

  it('never copies what the caller sent into the result', async () => {
    const payload = body();
    payload.templateCostText = 12345;
    payload.secretField = 'TOP-SECRET';
    const text = JSON.stringify(
      await fieldErrors(PutChatbotSettingsDto, payload),
    );
    expect(text).not.toContain('TOP-SECRET');
    expect(text).not.toContain('12345');
  });

  it('apply-to-all: type, range and unknown field', async () => {
    expect(
      await fieldErrors(ApplyToAllDto, {
        dryRun: 'yes',
        expectedVersion: -1,
        other: 1,
      }),
    ).toEqual(
      expect.arrayContaining([
        { path: 'dryRun', code: 'INVALID_TYPE' },
        { path: 'expectedVersion', code: 'OUT_OF_RANGE' },
        { path: 'other', code: 'UNKNOWN_FIELD' },
      ]),
    );
  });

  it('is null for a response that is not a validation list', () => {
    expect(validationErrorsOf({ message: 'nope' })).toBeNull();
    expect(validationErrorsOf(null)).toBeNull();
    expect(validationErrorsOf({ message: [] })).toBeNull();
  });
});
