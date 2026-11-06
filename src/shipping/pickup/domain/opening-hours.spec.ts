// shipping-zones / T7 (S10) — weekly opening hours rules and Spanish summary.
import { InvalidArgumentError } from '../../../shared/domain/domain-error';
import {
  DEFAULT_BUSINESS_TIME_ZONE,
  formatOpeningHoursEs,
  normalizeOpeningHours,
  type OpeningHoursInput,
} from './opening-hours';

const closedWeek = (): OpeningHoursInput['days'] =>
  (
    [
      'MONDAY',
      'TUESDAY',
      'WEDNESDAY',
      'THURSDAY',
      'FRIDAY',
      'SATURDAY',
      'SUNDAY',
    ] as const
  ).map((day) => ({ day, ranges: [] }));

const week = (
  overrides: Partial<
    Record<string, Array<{ open: string; close: string }>>
  > = {},
): OpeningHoursInput['days'] =>
  closedWeek().map((entry) => ({
    ...entry,
    ranges: overrides[entry.day] ?? [],
  }));

const expectInvalid = (input: OpeningHoursInput, fragment: string) => {
  let error: unknown;
  try {
    normalizeOpeningHours(input);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(InvalidArgumentError);
  expect((error as InvalidArgumentError).code).toBe('INVALID_OPENING_HOURS');
  expect((error as Error).message).toContain(fragment);
};

describe('normalizeOpeningHours', () => {
  it('orders days Monday→Sunday and ranges by opening time', () => {
    const days = week({
      MONDAY: [
        { open: '16:00', close: '20:00' },
        { open: '09:00', close: '14:00' },
      ],
    }).reverse();

    const result = normalizeOpeningHours({ days });

    expect(result.timeZone).toBe(DEFAULT_BUSINESS_TIME_ZONE);
    expect(result.days.map((d) => d.day)).toEqual([
      'MONDAY',
      'TUESDAY',
      'WEDNESDAY',
      'THURSDAY',
      'FRIDAY',
      'SATURDAY',
      'SUNDAY',
    ]);
    expect(result.days[0].ranges).toEqual([
      { open: '09:00', close: '14:00' },
      { open: '16:00', close: '20:00' },
    ]);
  });

  it('keeps a valid IANA time zone', () => {
    expect(
      normalizeOpeningHours({ timeZone: 'America/Monterrey', days: week() })
        .timeZone,
    ).toBe('America/Monterrey');
  });

  it('rejects an unknown time zone', () => {
    expectInvalid({ timeZone: 'Mars/Olympus', days: week() }, 'timeZone');
  });

  it('requires every weekday exactly once', () => {
    expectInvalid({ days: week().slice(0, 6) }, 'SUNDAY');
    const duplicated = week();
    duplicated[6] = { day: 'MONDAY', ranges: [] };
    expectInvalid({ days: duplicated }, 'MONDAY');
  });

  it('rejects a range whose opening is not before its closing', () => {
    expectInvalid(
      { days: week({ TUESDAY: [{ open: '14:00', close: '14:00' }] }) },
      'TUESDAY',
    );
    expectInvalid(
      { days: week({ TUESDAY: [{ open: '18:00', close: '09:00' }] }) },
      'TUESDAY',
    );
  });

  it('rejects overlapping or touching ranges on the same day', () => {
    expectInvalid(
      {
        days: week({
          FRIDAY: [
            { open: '09:00', close: '14:00' },
            { open: '13:30', close: '18:00' },
          ],
        }),
      },
      'FRIDAY',
    );
    expectInvalid(
      {
        days: week({
          FRIDAY: [
            { open: '09:00', close: '14:00' },
            { open: '14:00', close: '18:00' },
          ],
        }),
      },
      'FRIDAY',
    );
  });

  it('rejects malformed times', () => {
    expectInvalid(
      { days: week({ MONDAY: [{ open: '9:00', close: '14:00' }] }) },
      'MONDAY',
    );
    expectInvalid(
      { days: week({ MONDAY: [{ open: '09:00', close: '24:00' }] }) },
      'MONDAY',
    );
  });

  it('accepts a range closing at 23:59', () => {
    const result = normalizeOpeningHours({
      days: week({ SUNDAY: [{ open: '00:00', close: '23:59' }] }),
    });
    expect(result.days[6].ranges).toEqual([{ open: '00:00', close: '23:59' }]);
  });
});

describe('formatOpeningHoursEs', () => {
  it('groups consecutive days with the same ranges', () => {
    const hours = normalizeOpeningHours({
      days: week({
        MONDAY: [
          { open: '09:00', close: '14:00' },
          { open: '16:00', close: '20:00' },
        ],
        TUESDAY: [
          { open: '09:00', close: '14:00' },
          { open: '16:00', close: '20:00' },
        ],
        WEDNESDAY: [
          { open: '09:00', close: '14:00' },
          { open: '16:00', close: '20:00' },
        ],
        THURSDAY: [
          { open: '09:00', close: '14:00' },
          { open: '16:00', close: '20:00' },
        ],
        FRIDAY: [
          { open: '09:00', close: '14:00' },
          { open: '16:00', close: '20:00' },
        ],
        SATURDAY: [{ open: '10:00', close: '14:00' }],
      }),
    });

    const formatted = formatOpeningHoursEs(hours);

    expect(formatted.summary).toBe(
      'Lunes a viernes: 09:00–14:00 y 16:00–20:00. Sábado: 10:00–14:00. Domingo: cerrado.',
    );
    expect(formatted.timeZone).toBe(DEFAULT_BUSINESS_TIME_ZONE);
    expect(formatted.days[0]).toEqual({
      day: 'MONDAY',
      label: 'Lunes',
      closed: false,
      ranges: [
        { open: '09:00', close: '14:00' },
        { open: '16:00', close: '20:00' },
      ],
    });
    expect(formatted.days[6]).toEqual({
      day: 'SUNDAY',
      label: 'Domingo',
      closed: true,
      ranges: [],
    });
  });

  it('uses "y" for exactly two grouped days and lists non-consecutive groups separately', () => {
    const hours = normalizeOpeningHours({
      days: week({
        MONDAY: [{ open: '09:00', close: '18:00' }],
        TUESDAY: [{ open: '09:00', close: '18:00' }],
        THURSDAY: [{ open: '09:00', close: '18:00' }],
      }),
    });

    expect(formatOpeningHoursEs(hours).summary).toBe(
      'Lunes y martes: 09:00–18:00. Miércoles: cerrado. Jueves: 09:00–18:00. Viernes a domingo: cerrado.',
    );
  });

  it('says closed every day when no day has ranges', () => {
    expect(
      formatOpeningHoursEs(normalizeOpeningHours({ days: week() })).summary,
    ).toBe('Lunes a domingo: cerrado.');
  });
});
