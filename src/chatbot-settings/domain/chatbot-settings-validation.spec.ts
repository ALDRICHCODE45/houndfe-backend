/**
 * S11 (item 3, 4): `fieldErrors` of a rejected settings body. Every code and
 * path is a stable contract with the settings screen (handoff 16 §4), so each
 * one is pinned here. The existing `reason`/`message` of the domain error must
 * stay what they were (the old specs cover that); this file adds the list.
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  defaultSettings,
  normalizeSettingsInput,
  type AttentionSettingsInput,
} from './chatbot-attention-settings';
import {
  SettingsValidationError,
  type FieldError,
} from './chatbot-settings-validation';

const valid = (): AttentionSettingsInput =>
  JSON.parse(JSON.stringify(defaultSettings())) as AttentionSettingsInput;

/** The `fieldErrors` of a body that must be rejected. */
function rejected(mutate: (input: AttentionSettingsInput) => void): {
  error: SettingsValidationError;
  fieldErrors: FieldError[];
} {
  const input = valid();
  mutate(input);
  try {
    normalizeSettingsInput(input);
  } catch (error) {
    expect(error).toBeInstanceOf(SettingsValidationError);
    expect(error).toBeInstanceOf(InvalidArgumentError);
    const typed = error as SettingsValidationError;
    return { error: typed, fieldErrors: typed.fieldErrors };
  }
  throw new Error('the body was accepted');
}

const day = (input: AttentionSettingsInput, index: number) =>
  input.openingHours.days[index];

describe('fieldErrors of normalizeSettingsInput (S11)', () => {
  describe('opening hours', () => {
    it('OVERLAP on the later range, with the day and range index', () => {
      const { fieldErrors, error } = rejected((i) => {
        day(i, 1).ranges = [
          { open: '09:00', close: '14:00' },
          { open: '13:00', close: '18:00' },
        ];
      });
      expect(fieldErrors).toEqual([
        { path: 'openingHours.days[1].ranges[1]', code: 'OVERLAP' },
      ]);
      // the pickup domain's reason and wording are unchanged
      expect(error.code).toBe('INVALID_OPENING_HOURS');
    });

    it('OVERLAP also for ranges that touch, and follows the INPUT index even when unsorted', () => {
      const { fieldErrors } = rejected((i) => {
        day(i, 0).ranges = [
          { open: '14:00', close: '18:00' },
          { open: '09:00', close: '14:00' },
        ];
      });
      expect(fieldErrors).toEqual([
        { path: 'openingHours.days[0].ranges[0]', code: 'OVERLAP' },
      ]);
    });

    it('INVALID_TIME on the field that is not HH:mm', () => {
      const { fieldErrors } = rejected((i) => {
        day(i, 2).ranges = [{ open: '9:00', close: '24:00' }];
      });
      expect(fieldErrors).toEqual([
        { path: 'openingHours.days[2].ranges[0].open', code: 'INVALID_TIME' },
        { path: 'openingHours.days[2].ranges[0].close', code: 'INVALID_TIME' },
      ]);
    });

    it('CROSSES_MIDNIGHT when close is before open, EMPTY_RANGE when equal', () => {
      expect(
        rejected((i) => {
          day(i, 0).ranges = [{ open: '22:00', close: '02:00' }];
        }).fieldErrors,
      ).toEqual([
        { path: 'openingHours.days[0].ranges[0]', code: 'CROSSES_MIDNIGHT' },
      ]);
      expect(
        rejected((i) => {
          day(i, 0).ranges = [{ open: '10:00', close: '10:00' }];
        }).fieldErrors,
      ).toEqual([
        { path: 'openingHours.days[0].ranges[0]', code: 'EMPTY_RANGE' },
      ]);
    });

    it('INVALID_TIMEZONE', () => {
      const { fieldErrors } = rejected((i) => {
        i.openingHours.timeZone = 'Mars/Olympus';
      });
      expect(fieldErrors).toEqual([
        { path: 'openingHours.timeZone', code: 'INVALID_TIMEZONE' },
      ]);
    });

    it('TOO_MANY_RANGES above 6 per day (settings only)', () => {
      const { fieldErrors } = rejected((i) => {
        day(i, 3).ranges = Array.from({ length: 7 }, (_, n) => ({
          open: `${String(n * 3).padStart(2, '0')}:00`,
          close: `${String(n * 3).padStart(2, '0')}:30`,
        }));
      });
      expect(fieldErrors).toEqual([
        { path: 'openingHours.days[3].ranges', code: 'TOO_MANY_RANGES' },
      ]);
    });

    it('accepts exactly 6 ranges in a day', () => {
      const input = valid();
      day(input, 3).ranges = Array.from({ length: 6 }, (_, n) => ({
        open: `${String(n * 3).padStart(2, '0')}:00`,
        close: `${String(n * 3).padStart(2, '0')}:30`,
      }));
      expect(() => normalizeSettingsInput(input)).not.toThrow();
    });

    it('INVALID_DAY / DUPLICATE_DAY / REQUIRED for the week', () => {
      expect(
        rejected((i) => {
          day(i, 0).day = 'FUNDAY';
        }).fieldErrors,
      ).toEqual(
        expect.arrayContaining([
          { path: 'openingHours.days[0].day', code: 'INVALID_DAY' },
        ]),
      );
      expect(
        rejected((i) => {
          day(i, 1).day = 'MONDAY';
        }).fieldErrors,
      ).toEqual(
        expect.arrayContaining([
          { path: 'openingHours.days[1].day', code: 'DUPLICATE_DAY' },
          { path: 'openingHours.days', code: 'REQUIRED' },
        ]),
      );
      expect(
        rejected((i) => {
          i.openingHours.days = i.openingHours.days.slice(0, 6);
        }).fieldErrors,
      ).toEqual([{ path: 'openingHours.days', code: 'REQUIRED' }]);
    });

    it('NO_OPEN_RANGE for a week that is closed every day', () => {
      const { fieldErrors, error } = rejected((i) => {
        for (const d of i.openingHours.days) d.ranges = [];
      });
      expect(fieldErrors).toEqual([
        { path: 'openingHours.days', code: 'NO_OPEN_RANGE' },
      ]);
      expect(error.code).toBe('INVALID_CHATBOT_SETTINGS');
    });

    it('reports every problem of the week at once, not the first one', () => {
      const { fieldErrors } = rejected((i) => {
        day(i, 0).ranges = [{ open: '22:00', close: '02:00' }];
        day(i, 4).ranges = [
          { open: '09:00', close: '12:00' },
          { open: '11:00', close: '13:00' },
        ];
        i.openingHours.timeZone = 'Nope/Zone';
      });
      expect(fieldErrors).toEqual(
        expect.arrayContaining([
          { path: 'openingHours.timeZone', code: 'INVALID_TIMEZONE' },
          { path: 'openingHours.days[0].ranges[0]', code: 'CROSSES_MIDNIGHT' },
          { path: 'openingHours.days[4].ranges[1]', code: 'OVERLAP' },
        ]),
      );
      expect(fieldErrors).toHaveLength(3);
    });
  });

  describe('closed dates and reasons', () => {
    it('INVALID_DATE with the index of the entry', () => {
      const { fieldErrors } = rejected((i) => {
        i.closedDates = ['2026-12-25', '2026-02-30', 'tomorrow'];
      });
      expect(fieldErrors).toEqual([
        { path: 'closedDates[1]', code: 'INVALID_DATE' },
        { path: 'closedDates[2]', code: 'INVALID_DATE' },
      ]);
    });

    it('TOO_MANY_DATES above 400 distinct dates', () => {
      const start = Date.UTC(2026, 0, 1);
      const { fieldErrors } = rejected((i) => {
        i.closedDates = Array.from({ length: 401 }, (_, n) =>
          new Date(start + n * 86_400_000).toISOString().slice(0, 10),
        );
      });
      expect(fieldErrors).toEqual([
        { path: 'closedDates', code: 'TOO_MANY_DATES' },
      ]);
    });

    it('stays tolerant with a repeated date: sorted and unique, as before (no DUPLICATE_DATE)', () => {
      const input = valid();
      input.closedDates = ['2026-12-25', '2026-01-01', '2026-12-25'];
      expect(normalizeSettingsInput(input).closedDates).toEqual([
        '2026-01-01',
        '2026-12-25',
      ]);
    });

    it('defaults to no reasons, and stores them keyed by date with sorted keys', () => {
      expect(normalizeSettingsInput(valid()).closedDateReasons).toEqual({});
      const input = valid();
      input.closedDates = ['2026-12-25', '2026-01-01'];
      input.closedDateReasons = {
        '2026-12-25': '  Navidad ',
        '2026-01-01': 'Año nuevo',
      };
      const out = normalizeSettingsInput(input).closedDateReasons;
      expect(Object.keys(out)).toEqual(['2026-01-01', '2026-12-25']);
      expect(out['2026-12-25']).toBe('Navidad');
    });

    it('REASON_WITHOUT_DATE for a reason on a date that is not closed', () => {
      const { fieldErrors } = rejected((i) => {
        i.closedDates = ['2026-12-25'];
        i.closedDateReasons = { '2026-12-24': 'Nochebuena' };
      });
      expect(fieldErrors).toEqual([
        {
          path: 'closedDateReasons["2026-12-24"]',
          code: 'REASON_WITHOUT_DATE',
        },
      ]);
    });

    it('INVALID_DATE for a reason key that is not a real date', () => {
      const { fieldErrors } = rejected((i) => {
        i.closedDateReasons = { mañana: 'x', '2026-02-30': 'y' };
      });
      expect(fieldErrors).toEqual(
        expect.arrayContaining([
          { path: 'closedDateReasons["mañana"]', code: 'INVALID_DATE' },
          { path: 'closedDateReasons["2026-02-30"]', code: 'INVALID_DATE' },
        ]),
      );
    });

    it.each([
      ['empty', ''],
      ['blank', '   '],
      ['81 characters', 'x'.repeat(81)],
    ])('INVALID_LENGTH for a %s reason, 80 characters pass', (_l, reason) => {
      const { fieldErrors } = rejected((i) => {
        i.closedDates = ['2026-12-25'];
        i.closedDateReasons = { '2026-12-25': reason };
      });
      expect(fieldErrors).toEqual([
        {
          path: 'closedDateReasons["2026-12-25"]',
          code: 'INVALID_LENGTH',
        },
      ]);
      const ok = valid();
      ok.closedDates = ['2026-12-25'];
      ok.closedDateReasons = { '2026-12-25': 'x'.repeat(80) };
      expect(() => normalizeSettingsInput(ok)).not.toThrow();
    });

    it('INVALID_TYPE for a non-string reason or a non-object map, INVALID_TEXT for control characters', () => {
      expect(
        rejected((i) => {
          i.closedDates = ['2026-12-25'];
          i.closedDateReasons = { '2026-12-25': 5 as never };
        }).fieldErrors,
      ).toEqual([
        { path: 'closedDateReasons["2026-12-25"]', code: 'INVALID_TYPE' },
      ]);
      expect(
        rejected((i) => {
          i.closedDateReasons = [] as never;
        }).fieldErrors,
      ).toEqual([{ path: 'closedDateReasons', code: 'INVALID_TYPE' }]);
      expect(
        rejected((i) => {
          i.closedDates = ['2026-12-25'];
          i.closedDateReasons = { '2026-12-25': 'a\u0000b' };
        }).fieldErrors,
      ).toEqual([
        { path: 'closedDateReasons["2026-12-25"]', code: 'INVALID_TEXT' },
      ]);
    });

    it('a __proto__ key is just an invalid date, never a prototype write', () => {
      const input = valid();
      input.closedDateReasons = JSON.parse('{"__proto__": "x"}') as never;
      expect(() => normalizeSettingsInput(input)).toThrow(
        SettingsValidationError,
      );
      expect(({} as Record<string, unknown>).x).toBeUndefined();
    });
  });

  describe('SLA table', () => {
    const entry = (input: AttentionSettingsInput, subtype: string) =>
      input.slas.findIndex((s) => s.subtype === subtype);

    it('RESOLVE_BELOW_CLAIM on slas[n].resolveMinutes', () => {
      const { fieldErrors } = rejected((i) => {
        const n = entry(i, 'RESTOCK');
        i.slas[n].claimMinutes = 120;
        i.slas[n].resolveMinutes = 60;
      });
      expect(fieldErrors).toEqual([
        { path: 'slas[0].resolveMinutes', code: 'RESOLVE_BELOW_CLAIM' },
      ]);
    });

    it('MUST_BE_NULL for the receipt resolve time', () => {
      const { fieldErrors } = rejected((i) => {
        i.slas[entry(i, 'TRANSFER_RECEIPT')].resolveMinutes = 60;
      });
      expect(fieldErrors).toEqual([
        { path: 'slas[3].resolveMinutes', code: 'MUST_BE_NULL' },
      ]);
    });

    it.each([0, -5, 1.5, 10081])(
      'OUT_OF_RANGE for %p minutes, on the field that is wrong',
      (minutes) => {
        const { fieldErrors } = rejected((i) => {
          i.slas[5].resolveMinutes = minutes;
        });
        expect(fieldErrors).toEqual([
          { path: 'slas[5].resolveMinutes', code: 'OUT_OF_RANGE' },
        ]);
      },
    );

    it('INVALID_VALUE / DUPLICATE_SUBTYPE / REQUIRED', () => {
      expect(
        rejected((i) => {
          i.slas[0].subtype = 'NOPE' as never;
        }).fieldErrors,
      ).toEqual(
        expect.arrayContaining([
          { path: 'slas[0].subtype', code: 'INVALID_VALUE' },
          { path: 'slas', code: 'REQUIRED' },
        ]),
      );
      expect(
        rejected((i) => {
          i.slas[7] = { ...i.slas[1] };
        }).fieldErrors,
      ).toEqual(
        expect.arrayContaining([
          { path: 'slas[7].subtype', code: 'DUPLICATE_SUBTYPE' },
          { path: 'slas', code: 'REQUIRED' },
        ]),
      );
      expect(
        rejected((i) => {
          i.slas = i.slas.slice(1);
        }).fieldErrors,
      ).toEqual([{ path: 'slas', code: 'REQUIRED' }]);
    });
  });

  describe('scalars', () => {
    it.each([
      ['windowWarningMinutes', -1],
      ['windowWarningMinutes', 1441],
      ['receiptCloseMarginMinutes', 1.5],
    ] as const)('OUT_OF_RANGE on %s = %p', (field, value) => {
      const { fieldErrors } = rejected((i) => {
        i[field] = value;
      });
      expect(fieldErrors).toEqual([{ path: field, code: 'OUT_OF_RANGE' }]);
    });

    it.each([
      ['slotMinutes', 4],
      ['slotsOffered', 11],
      ['maxScheduledPerSlot', 0],
    ] as const)('OUT_OF_RANGE on scheduling.%s = %p', (field, value) => {
      const { fieldErrors } = rejected((i) => {
        i.scheduling[field] = value;
      });
      expect(fieldErrors).toEqual([
        { path: `scheduling.${field}`, code: 'OUT_OF_RANGE' },
      ]);
    });

    it('text fields: INVALID_LENGTH, INVALID_TEXT, INVALID_TEMPLATE_NAME, INVALID_VALUE', () => {
      expect(
        rejected((i) => {
          i.templateCostText = '   ';
        }).fieldErrors,
      ).toEqual([{ path: 'templateCostText', code: 'INVALID_LENGTH' }]);
      expect(
        rejected((i) => {
          i.templateCostText = 'a\u0000b';
        }).fieldErrors,
      ).toEqual([{ path: 'templateCostText', code: 'INVALID_TEXT' }]);
      expect(
        rejected((i) => {
          i.templateName = 'Has Spaces';
        }).fieldErrors,
      ).toEqual([{ path: 'templateName', code: 'INVALID_TEMPLATE_NAME' }]);
      expect(
        rejected((i) => {
          i.enabledSubtypes = ['RESTOCK', 'NOPE' as never];
        }).fieldErrors,
      ).toEqual([{ path: 'enabledSubtypes[1]', code: 'INVALID_VALUE' }]);
    });
  });

  it('keeps the generic message of the first rule, as before (never echoes input)', () => {
    const { error } = rejected((i) => {
      day(i, 0).ranges = [
        { open: '09:00', close: '14:00' },
        { open: '13:00', close: '18:00' },
      ];
    });
    expect(error.message).toBe('MONDAY: ranges must not overlap or touch');
  });

  /**
   * Drift guard: the field-error collector re-states the opening-hours rules
   * (the pickup domain only throws the first one, without a path). The domain
   * stays the authority: a body is rejected exactly when the old rules
   * rejected it, and never with an empty list.
   */
  it('rejects every body the pickup domain rejects, with a non-empty list', () => {
    const cases: Array<(i: AttentionSettingsInput) => void> = [
      (i) => (day(i, 0).ranges = [{ open: '9:00', close: '10:00' }]),
      (i) => (day(i, 0).ranges = [{ open: '10:00', close: '10:00' }]),
      (i) => (day(i, 0).ranges = [{ open: '10:00', close: '09:00' }]),
      (i) =>
        (day(i, 0).ranges = [
          { open: '09:00', close: '10:00' },
          { open: '10:00', close: '11:00' },
        ]),
      (i) => (i.openingHours.timeZone = 'Mars/Olympus'),
      (i) => (day(i, 6).day = 'MONDAY'),
      (i) => (day(i, 6).day = 'SOMEDAY'),
      (i) => (i.openingHours.days = i.openingHours.days.slice(1)),
      (i) => i.openingHours.days.forEach((d) => (d.ranges = [])),
    ];
    for (const mutate of cases) {
      const { fieldErrors } = rejected(mutate);
      expect(fieldErrors.length).toBeGreaterThan(0);
    }
  });
});
