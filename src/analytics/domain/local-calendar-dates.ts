/**
 * Local calendar date enumeration shared by the analytics services (branch
 * timeseries, seller report `dailyTotals`). Integer arithmetic only, so host
 * timezone, locale and tzdata cannot change the output.
 */

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days in a Gregorian month — pure arithmetic, never `Date`. */
function daysInMonth(year: number, month: number): number {
  if (month !== 2) return MONTH_LENGTHS[month - 1];
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return isLeapYear ? 29 : 28;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * Every local calendar date in `[from,to)`, ascending. Both bounds are exact
 * `YYYY-MM-DD` strings, so byte order is chronological order and no `Date`
 * parsing (which reads a bare date as UTC midnight) participates. The year is
 * re-padded to four digits because valid DTO years run down to `0001`.
 */
export function enumerateLocalCalendarDates(
  from: string,
  to: string,
): string[] {
  const dates: string[] = [];
  if (to <= from) return dates;
  const [startYear, startMonth, startDay] = from.split('-').map(Number);
  let year = startYear;
  let month = startMonth;
  let day = startDay;
  let date = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;

  while (date < to) {
    dates.push(date);
    day += 1;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    date = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
  }

  return dates;
}
