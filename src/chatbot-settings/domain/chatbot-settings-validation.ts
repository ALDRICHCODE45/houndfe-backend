/**
 * DOMAIN: field-level validation of a chatbot settings body (S11). Pure.
 *
 * `collectFieldErrors` walks the body and returns EVERY problem as
 * `{path, code}` (JSON-path-like `path`, stable `code`), so the settings
 * screen can mark each field at once. `normalizeSettingsInput` stays the
 * authority on what is accepted: it still runs the pickup opening-hours
 * rules unchanged (`normalizeOpeningHours`, which throws the first problem
 * without a path) and this collector only adds the location. The two are
 * kept in step by a differential spec.
 *
 * Codes are a contract with the frontend (handoff 16 §4):
 *   REQUIRED, INVALID_TYPE, INVALID_VALUE, UNKNOWN_FIELD, OUT_OF_RANGE,
 *   INVALID_LENGTH, INVALID_TEXT, INVALID_TEMPLATE_NAME,
 *   INVALID_LANGUAGE_CODE,
 *   INVALID_TIME, CROSSES_MIDNIGHT, EMPTY_RANGE, OVERLAP, TOO_MANY_RANGES,
 *   INVALID_TIMEZONE, INVALID_DAY, DUPLICATE_DAY, NO_OPEN_RANGE,
 *   INVALID_DATE, TOO_MANY_DATES, REASON_WITHOUT_DATE,
 *   DUPLICATE_SUBTYPE, MUST_BE_NULL, RESOLVE_BELOW_CLAIM.
 * (`DUPLICATE_DATE` is not emitted: a repeated closed date is still merged.)
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { isCalendarDate } from '../../chatbot-requests/domain/business-hours-calendar';
import {
  DEFAULT_BUSINESS_TIME_ZONE,
  WEEKDAYS,
} from '../../shipping/pickup/domain/opening-hours';

export interface FieldError {
  path: string;
  code: string;
}

/** A rejected settings body: the domain error plus the located problems. */
export class SettingsValidationError extends InvalidArgumentError {
  constructor(
    message: string,
    code: string,
    readonly fieldErrors: FieldError[],
  ) {
    super(message, code);
  }
}

/** Settings-only cap (the pickup editor has its own). */
export const MAX_RANGES_PER_DAY = 6;
export const MAX_CLOSED_DATES = 400;
export const MAX_REASON_LENGTH = 80;
export const MAX_SLA_MINUTES = 10_080;

/**
 * S16 1a: how long a claim waits for the bot's `session-ack STARTED`. The
 * floor leaves the bot time to read the feed and answer under a slow poll;
 * the ceiling stops a typo from leaving a customer muted for hours with
 * nobody answering (the migration CHECK repeats both).
 */
export const START_TIMEOUT_MIN_SECONDS = 30;
export const START_TIMEOUT_MAX_SECONDS = 600;
export const DEFAULT_START_TIMEOUT_SECONDS = 120;

/** S16 8: the WhatsApp template language code, `xx` or `xx_YY` (Meta's shape). */
export const TEMPLATE_LANGUAGE_CODE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
export const DEFAULT_TEMPLATE_LANGUAGE_CODE = 'es_MX';

const SUBTYPES = [
  'RESTOCK',
  'EXPIRATION',
  'DELIVERY_ZONE',
  'TRANSFER_RECEIPT',
  'TALK_TO_HUMAN',
  'COMPLAINT',
  'UNKNOWN_QUESTION',
  'DISCOUNT',
] as const;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const minutes = (time: string): number =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const inRange = (value: unknown, min: number, max: number): boolean =>
  Number.isInteger(value) &&
  (value as number) >= min &&
  (value as number) <= max;

/** The path of one key of the reasons map. */
export const reasonPath = (date: string): string =>
  `closedDateReasons[${JSON.stringify(date)}]`;

/** Loose view of a body: the DTO checked the shapes, the domain does not trust it. */
type Loose = Record<string, unknown>;

export function collectFieldErrors(input: unknown): FieldError[] {
  const out: FieldError[] = [];
  const add = (path: string, code: string) => out.push({ path, code });
  const body = (isRecord(input) ? input : {}) as Loose;

  collectOpeningHours(body.openingHours, add);
  const closed = collectClosedDates(body.closedDates, add);
  collectReasons(body.closedDateReasons, closed, add);
  collectSlas(body.slas, add);

  if (!inRange(body.windowWarningMinutes, 0, 1440)) {
    add('windowWarningMinutes', 'OUT_OF_RANGE');
  }
  if (!inRange(body.receiptCloseMarginMinutes, 0, 1440)) {
    add('receiptCloseMarginMinutes', 'OUT_OF_RANGE');
  }

  // Additive (S16): absent or null keeps the stored value (the service fills it).
  if (
    body.startTimeoutSeconds !== undefined &&
    body.startTimeoutSeconds !== null &&
    !inRange(
      body.startTimeoutSeconds,
      START_TIMEOUT_MIN_SECONDS,
      START_TIMEOUT_MAX_SECONDS,
    )
  ) {
    add('startTimeoutSeconds', 'OUT_OF_RANGE');
  }
  const language = body.templateLanguageCode;
  if (
    language !== undefined &&
    language !== null &&
    (typeof language !== 'string' || !TEMPLATE_LANGUAGE_CODE.test(language))
  ) {
    add('templateLanguageCode', 'INVALID_LANGUAGE_CODE');
  }

  const text = body.templateCostText;
  if (typeof text !== 'string') add('templateCostText', 'INVALID_TYPE');
  else if (text.trim().length < 1 || text.trim().length > 200) {
    add('templateCostText', 'INVALID_LENGTH');
  } else if (CONTROL.test(text.trim())) add('templateCostText', 'INVALID_TEXT');

  const name = body.templateName;
  if (
    name !== null &&
    (typeof name !== 'string' || !TEMPLATE_NAME.test(name))
  ) {
    add('templateName', 'INVALID_TEMPLATE_NAME');
  }

  if (Array.isArray(body.enabledSubtypes)) {
    body.enabledSubtypes.forEach((subtype, index) => {
      if (!(SUBTYPES as readonly unknown[]).includes(subtype)) {
        add(`enabledSubtypes[${index}]`, 'INVALID_VALUE');
      }
    });
  }

  const scheduling = isRecord(body.scheduling) ? body.scheduling : {};
  const bounds: Array<[string, number, number]> = [
    ['slotMinutes', 5, 240],
    ['slotsOffered', 1, 10],
    ['maxScheduledPerSlot', 1, 50],
  ];
  for (const [field, min, max] of bounds) {
    if (!inRange(scheduling[field], min, max)) {
      add(`scheduling.${field}`, 'OUT_OF_RANGE');
    }
  }
  return out;
}

type Add = (path: string, code: string) => void;

function collectOpeningHours(value: unknown, add: Add): void {
  const hours = (isRecord(value) ? value : {}) as Loose;
  const zone = typeof hours.timeZone === 'string' ? hours.timeZone.trim() : '';
  if (zone !== '' && !isTimeZone(zone)) {
    add('openingHours.timeZone', 'INVALID_TIMEZONE');
  } else if (zone === '' && !isTimeZone(DEFAULT_BUSINESS_TIME_ZONE)) {
    add('openingHours.timeZone', 'INVALID_TIMEZONE');
  }

  const days = Array.isArray(hours.days) ? (hours.days as unknown[]) : [];
  const seen = new Set<string>();
  let problems = 0;
  let anyRange = false;
  days.forEach((entry, index) => {
    const base = `openingHours.days[${index}]`;
    const day = (isRecord(entry) ? entry : {}) as Loose;
    const name = day.day;
    if (!(WEEKDAYS as readonly unknown[]).includes(name)) {
      add(`${base}.day`, 'INVALID_DAY');
      problems++;
    } else if (seen.has(name as string)) {
      add(`${base}.day`, 'DUPLICATE_DAY');
      problems++;
    } else seen.add(name as string);

    const ranges = Array.isArray(day.ranges) ? (day.ranges as unknown[]) : [];
    if (ranges.length > MAX_RANGES_PER_DAY) {
      add(`${base}.ranges`, 'TOO_MANY_RANGES');
      problems++;
    }
    if (ranges.length > 0) anyRange = true;
    const usable: Array<{ index: number; open: number; close: number }> = [];
    ranges.forEach((raw, rangeIndex) => {
      const at = `${base}.ranges[${rangeIndex}]`;
      const range = (isRecord(raw) ? raw : {}) as Loose;
      const open = range.open;
      const close = range.close;
      const openOk = typeof open === 'string' && TIME.test(open);
      const closeOk = typeof close === 'string' && TIME.test(close);
      if (!openOk) add(`${at}.open`, 'INVALID_TIME');
      if (!closeOk) add(`${at}.close`, 'INVALID_TIME');
      if (!openOk || !closeOk) {
        problems++;
        return;
      }
      const from = minutes(open);
      const to = minutes(close);
      if (from > to) {
        add(at, 'CROSSES_MIDNIGHT');
        problems++;
      } else if (from === to) {
        add(at, 'EMPTY_RANGE');
        problems++;
      } else usable.push({ index: rangeIndex, open: from, close: to });
    });
    usable.sort((a, b) => a.open - b.open);
    for (let i = 1; i < usable.length; i++) {
      if (usable[i].open <= usable[i - 1].close) {
        add(`${base}.ranges[${usable[i].index}]`, 'OVERLAP');
        problems++;
      }
    }
  });
  if (WEEKDAYS.some((weekday) => !seen.has(weekday))) {
    add('openingHours.days', 'REQUIRED');
  } else if (problems === 0 && !anyRange) {
    add('openingHours.days', 'NO_OPEN_RANGE');
  }
}

/** Returns the set of valid closed dates (for the reasons check). */
function collectClosedDates(value: unknown, add: Add): Set<string> {
  const valid = new Set<string>();
  const dates = Array.isArray(value) ? (value as unknown[]) : [];
  dates.forEach((date, index) => {
    if (typeof date !== 'string' || !isCalendarDate(date)) {
      add(`closedDates[${index}]`, 'INVALID_DATE');
    } else valid.add(date);
  });
  if (valid.size > MAX_CLOSED_DATES) add('closedDates', 'TOO_MANY_DATES');
  return valid;
}

function collectReasons(value: unknown, closed: Set<string>, add: Add): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    add('closedDateReasons', 'INVALID_TYPE');
    return;
  }
  for (const key of Object.keys(value)) {
    const path = reasonPath(key);
    if (!isCalendarDate(key)) {
      add(path, 'INVALID_DATE');
      continue;
    }
    if (!closed.has(key)) {
      add(path, 'REASON_WITHOUT_DATE');
      continue;
    }
    const reason = value[key];
    if (typeof reason !== 'string') add(path, 'INVALID_TYPE');
    else if (
      reason.trim().length < 1 ||
      Array.from(reason.trim()).length > MAX_REASON_LENGTH
    ) {
      add(path, 'INVALID_LENGTH');
    } else if (CONTROL.test(reason.trim())) add(path, 'INVALID_TEXT');
  }
}

function collectSlas(value: unknown, add: Add): void {
  const entries = Array.isArray(value) ? (value as unknown[]) : [];
  const seen = new Set<string>();
  let incomplete = false;
  entries.forEach((raw, index) => {
    const base = `slas[${index}]`;
    const entry = (isRecord(raw) ? raw : {}) as Loose;
    const subtype = entry.subtype;
    if (!(SUBTYPES as readonly unknown[]).includes(subtype)) {
      add(`${base}.subtype`, 'INVALID_VALUE');
      incomplete = true;
    } else if (seen.has(subtype as string)) {
      add(`${base}.subtype`, 'DUPLICATE_SUBTYPE');
    } else seen.add(subtype as string);

    const claim = entry.claimMinutes ?? null;
    const resolve = entry.resolveMinutes ?? null;
    const claimOk = claim === null || inRange(claim, 1, MAX_SLA_MINUTES);
    const resolveOk = resolve === null || inRange(resolve, 1, MAX_SLA_MINUTES);
    if (!claimOk) add(`${base}.claimMinutes`, 'OUT_OF_RANGE');
    if (!resolveOk) add(`${base}.resolveMinutes`, 'OUT_OF_RANGE');
    if (subtype === 'TRANSFER_RECEIPT' && resolve !== null && resolveOk) {
      add(`${base}.resolveMinutes`, 'MUST_BE_NULL');
    } else if (
      claimOk &&
      resolveOk &&
      claim !== null &&
      resolve !== null &&
      (resolve as number) < (claim as number)
    ) {
      add(`${base}.resolveMinutes`, 'RESOLVE_BELOW_CLAIM');
    }
  });
  if (incomplete || SUBTYPES.some((subtype) => !seen.has(subtype))) {
    add('slas', 'REQUIRED');
  }
}
