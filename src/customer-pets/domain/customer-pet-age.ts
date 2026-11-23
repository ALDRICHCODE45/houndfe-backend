import type { ApproxAge, PetBirthDatePrecision } from './customer-pet.types';

/**
 * Derived age (contract §1.2). Pure: `today` is the calendar date (`YYYY-MM-DD`)
 * of the tenant timezone, computed by the caller.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `true` for a real `YYYY-MM-DD` calendar date (no `2023-02-30`, no time part). */
export function isRealIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parts(date: string): [number, number, number] {
  const match = ISO_DATE.exec(date) as RegExpExecArray;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** «mes/meses» and «año/años» agree with the count. */
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * `«menos de 1 mes»`, `«10 meses»`, `«3 años»`, `«1 año 4 meses»`; `«~»` in
 * front when the date is approximate (MONTH or YEAR precision, never the word
 * «aprox»). «menos de 1 mes» already says it is approximate and takes no prefix.
 */
export function petAgeLabel(
  months: number,
  precision: PetBirthDatePrecision,
): string {
  if (months < 1) return 'menos de 1 mes';
  const years = Math.floor(months / 12);
  const rest = months % 12;
  let label: string;
  if (years === 0) label = plural(rest, 'mes', 'meses');
  else if (rest === 0) label = plural(years, 'año', 'años');
  else
    label = `${plural(years, 'año', 'años')} ${plural(rest, 'mes', 'meses')}`;
  return precision === 'EXACT' ? label : `~${label}`;
}

/** Whole months between `birthDate` and `today`, never negative. */
export function wholeMonthsBetween(birthDate: string, today: string): number {
  const [by, bm, bd] = parts(birthDate);
  const [ty, tm, td] = parts(today);
  const months = (ty - by) * 12 + (tm - bm) - (td < bd ? 1 : 0);
  return Math.max(months, 0);
}

export function derivePetAge(
  birthDate: string | null,
  precision: PetBirthDatePrecision | null,
  today: string,
): { ageMonths: number | null; ageLabel: string | null } {
  if (!birthDate) return { ageMonths: null, ageLabel: null };
  const ageMonths = wholeMonthsBetween(birthDate, today);
  return {
    ageMonths,
    ageLabel: petAgeLabel(ageMonths, precision ?? 'EXACT'),
  };
}

/**
 * `approxAge` → stored date (contract §1.2 table): years only → January 1 of
 * (current year − years), `YEAR`; otherwise the first day of
 * (today − (12·years + months) months), `MONTH`.
 */
export function approxAgeToBirth(
  approx: ApproxAge,
  today: string,
): { birthDate: string; birthDatePrecision: 'MONTH' | 'YEAR' } {
  const [year, month] = parts(today);
  const years = approx.years ?? 0;
  if (approx.months === undefined) {
    return {
      birthDate: `${pad(year - years, 4)}-01-01`,
      birthDatePrecision: 'YEAR',
    };
  }
  const total = year * 12 + (month - 1) - (years * 12 + approx.months);
  return {
    birthDate: `${pad(Math.floor(total / 12), 4)}-${pad((total % 12) + 1, 2)}-01`,
    birthDatePrecision: 'MONTH',
  };
}
