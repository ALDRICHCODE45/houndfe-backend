/**
 * Branch analytics summary — request query contract (branch-analytics-summary / bas-1).
 *
 * The range is a business-day interval in `America/Mexico_City`, half-open
 * `[from, to)`: `from` inclusive, `to` exclusive. Bounds are LOCAL calendar
 * dates supplied as exact `YYYY-MM-DD` strings — never instants. Parsing
 * `new Date('YYYY-MM-DD')` resolves to UTC midnight and silently shifts the
 * intended local day by the business-timezone offset, so values stay strings
 * at the transport boundary; converting a local date to the matching UTC
 * instant is bas-2 service work and can reuse the helpers exported here.
 *
 * Range size is capped at `MAX_ANALYTICS_RANGE_DAYS`, measured as the half-open
 * distance `to - from`.
 */
import {
  IsString,
  Matches,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/** Business timezone for every analytics business-day boundary. */
export const ANALYTICS_TIME_ZONE = 'America/Mexico_City';

/** Exact local-calendar-date form: four-digit year, zero-padded month/day. */
export const LOCAL_CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Largest accepted range span, counted in local calendar days. */
export const MAX_ANALYTICS_RANGE_DAYS = 366;

/** Days in a Gregorian calendar month — pure arithmetic, host-timezone free. */
function daysInCalendarMonth(year: number, month: number): number {
  if (month === 2) {
    const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return isLeapYear ? 29 : 28;
  }
  const monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return monthLengths[month - 1];
}

/**
 * Day number with 0001-01-01 as 1, in the proleptic Gregorian calendar and
 * integer arithmetic only — never `Date`, `Date.UTC`, or the host timezone.
 * Year 0000 is rejected before this runs, so `year - 1` is never negative and
 * truncation matches floor for the leap-year divisors.
 */
function localCalendarDayNumber(value: string): number {
  const [year, month, day] = value.split('-').map((part) => Number(part));
  const priorYears = year - 1;
  const leapDays =
    Math.floor(priorYears / 4) -
    Math.floor(priorYears / 100) +
    Math.floor(priorYears / 400);
  let ordinal = priorYears * 365 + leapDays + day;
  for (let monthIndex = 1; monthIndex < month; monthIndex += 1) {
    ordinal += daysInCalendarMonth(year, monthIndex);
  }
  return ordinal;
}

/**
 * Guard shared by the DTO validators and the future summary service: true
 * only for an exact `YYYY-MM-DD` string naming a real Gregorian day.
 */
export function isExactLocalCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !LOCAL_CALENDAR_DATE_PATTERN.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map((part) => Number(part));
  // Year 0000 passes the regex but is not a proleptic-Gregorian date.
  if (year < 1) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInCalendarMonth(year, month)) return false;
  return true;
}

@ValidatorConstraint({ name: 'exactLocalCalendarDate', async: false })
class ExactLocalCalendarDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isExactLocalCalendarDate(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be an exact YYYY-MM-DD local calendar date in ${ANALYTICS_TIME_ZONE}`;
  }
}

/** Half-open rule: `to` must be strictly after `from`; silent when a bound is invalid. */
@ValidatorConstraint({ name: 'localDateRangeEnd', async: false })
class LocalDateRangeEndConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const from = (args.object as { from?: unknown }).from;
    if (!isExactLocalCalendarDate(from) || !isExactLocalCalendarDate(value)) {
      return true;
    }
    // Canonical zero-padded ISO dates compare correctly as strings.
    return value > from;
  }

  defaultMessage(): string {
    return 'to must be a local calendar date strictly after from (range is half-open [from, to))';
  }
}

/** Size rule: silent when a bound is invalid so the shape validators speak first. */
@ValidatorConstraint({ name: 'localDateRangeSpan', async: false })
class LocalDateRangeSpanConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const from = (args.object as { from?: unknown }).from;
    if (!isExactLocalCalendarDate(from) || !isExactLocalCalendarDate(value)) {
      return true;
    }
    const span = localCalendarDayNumber(value) - localCalendarDayNumber(from);
    return span <= MAX_ANALYTICS_RANGE_DAYS;
  }

  defaultMessage(): string {
    return `to must be at most ${MAX_ANALYTICS_RANGE_DAYS} calendar days after from in ${ANALYTICS_TIME_ZONE}`;
  }
}

export class BranchSalesSummaryQueryDto {
  /** Inclusive local start date (YYYY-MM-DD). */
  @IsString()
  @Matches(LOCAL_CALENDAR_DATE_PATTERN, {
    message: `from must match YYYY-MM-DD in ${ANALYTICS_TIME_ZONE}`,
  })
  @Validate(ExactLocalCalendarDateConstraint)
  from: string;

  /** Exclusive local end date (YYYY-MM-DD). */
  @IsString()
  @Matches(LOCAL_CALENDAR_DATE_PATTERN, {
    message: `to must match YYYY-MM-DD in ${ANALYTICS_TIME_ZONE}`,
  })
  @Validate(ExactLocalCalendarDateConstraint)
  @Validate(LocalDateRangeEndConstraint)
  @Validate(LocalDateRangeSpanConstraint)
  to: string;
}
