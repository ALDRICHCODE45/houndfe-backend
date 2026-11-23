import {
  approxAgeToBirth,
  derivePetAge,
  isRealIsoDate,
  petAgeLabel,
} from './customer-pet-age';

describe('petAgeLabel (contract §1.2)', () => {
  it.each([
    [0, 'menos de 1 mes'],
    [1, '1 mes'],
    [10, '10 meses'],
    [11, '11 meses'],
    [12, '1 año'],
    [13, '1 año 1 mes'],
    [16, '1 año 4 meses'],
    [24, '2 años'],
    [25, '2 años 1 mes'],
    [36, '3 años'],
    [47, '3 años 11 meses'],
    [180, '15 años'],
  ])('%i months → «%s»', (months, label) => {
    expect(petAgeLabel(months, 'EXACT')).toBe(label);
  });

  it.each(['MONTH', 'YEAR'] as const)(
    'prefixes «~» (never «aprox») for %s precision',
    (precision) => {
      expect(petAgeLabel(10, precision)).toBe('~10 meses');
      expect(petAgeLabel(36, precision)).toBe('~3 años');
      expect(petAgeLabel(16, precision)).toBe('~1 año 4 meses');
      expect(petAgeLabel(10, precision)).not.toMatch(/aprox/i);
    },
  );

  it('never prefixes «menos de 1 mes»', () => {
    expect(petAgeLabel(0, 'MONTH')).toBe('menos de 1 mes');
    expect(petAgeLabel(0, 'YEAR')).toBe('menos de 1 mes');
  });
});

describe('derivePetAge', () => {
  it('is null/null without a birth date', () => {
    expect(derivePetAge(null, null, '2026-11-23')).toEqual({
      ageMonths: null,
      ageLabel: null,
    });
  });

  it.each([
    // [birthDate, today, months]
    ['2026-11-23', '2026-11-23', 0],
    ['2026-10-24', '2026-11-23', 0],
    ['2026-10-23', '2026-11-23', 1],
    ['2026-01-01', '2026-11-23', 10],
    ['2025-11-23', '2026-11-23', 12],
    ['2025-11-24', '2026-11-23', 11],
    ['2024-03-15', '2026-11-23', 32],
    ['2024-03-31', '2024-04-30', 0],
    ['2020-02-29', '2026-02-28', 71],
  ])('%s on %s is %i whole months', (birth, today, months) => {
    expect(derivePetAge(birth, 'EXACT', today).ageMonths).toBe(months);
  });

  it('combines months and label with the precision prefix', () => {
    expect(derivePetAge('2026-01-01', 'MONTH', '2026-11-23')).toEqual({
      ageMonths: 10,
      ageLabel: '~10 meses',
    });
    expect(derivePetAge('2024-03-15', 'EXACT', '2026-11-23')).toEqual({
      ageMonths: 32,
      ageLabel: '2 años 8 meses',
    });
  });

  it('clamps a date later than today to 0 months instead of a negative age', () => {
    expect(derivePetAge('2026-12-01', 'EXACT', '2026-11-23').ageMonths).toBe(0);
  });
});

describe('approxAgeToBirth (contract §1.2 table)', () => {
  const today = '2026-11-23';

  it('{ months: 10 } → first day of (today − 10 months), MONTH', () => {
    expect(approxAgeToBirth({ months: 10 }, today)).toEqual({
      birthDate: '2026-01-01',
      birthDatePrecision: 'MONTH',
    });
  });

  it('{ years: 3 } → January 1 of (current year − 3), YEAR', () => {
    expect(approxAgeToBirth({ years: 3 }, today)).toEqual({
      birthDate: '2023-01-01',
      birthDatePrecision: 'YEAR',
    });
  });

  it('{ years: 1, months: 4 } → first day of (today − 16 months), MONTH', () => {
    expect(approxAgeToBirth({ years: 1, months: 4 }, today)).toEqual({
      birthDate: '2025-07-01',
      birthDatePrecision: 'MONTH',
    });
  });

  it('crosses the year boundary going back', () => {
    expect(approxAgeToBirth({ months: 11 }, '2026-03-10')).toEqual({
      birthDate: '2025-04-01',
      birthDatePrecision: 'MONTH',
    });
    expect(approxAgeToBirth({ months: 2 }, '2026-01-31')).toEqual({
      birthDate: '2025-11-01',
      birthDatePrecision: 'MONTH',
    });
  });

  it('{ months: 0 } is the first day of the current month', () => {
    expect(approxAgeToBirth({ months: 0 }, today)).toEqual({
      birthDate: '2026-11-01',
      birthDatePrecision: 'MONTH',
    });
  });

  it('{ years: 0 } is January 1 of the current year (YEAR)', () => {
    expect(approxAgeToBirth({ years: 0 }, today)).toEqual({
      birthDate: '2026-01-01',
      birthDatePrecision: 'YEAR',
    });
  });

  it('round-trips: the converted date yields the age that was asked for', () => {
    const b = approxAgeToBirth({ years: 1, months: 4 }, today);
    expect(derivePetAge(b.birthDate, b.birthDatePrecision, today)).toEqual({
      ageMonths: 16,
      ageLabel: '~1 año 4 meses',
    });
    const m = approxAgeToBirth({ months: 10 }, today);
    expect(
      derivePetAge(m.birthDate, m.birthDatePrecision, today).ageLabel,
    ).toBe('~10 meses');
  });
});

describe('isRealIsoDate', () => {
  it.each([
    ['2024-03-15', true],
    ['2024-02-29', true],
    ['2023-02-29', false],
    ['2024-13-01', false],
    ['2024-00-10', false],
    ['2024-3-5', false],
    ['2024-03-15T00:00:00Z', false],
    ['', false],
    ['hoy', false],
  ])('%s → %s', (value, ok) => {
    expect(isRealIsoDate(value)).toBe(ok);
  });
});
