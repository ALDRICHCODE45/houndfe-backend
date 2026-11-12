/**
 * DOMAIN: per-tenant chatbot attention settings (human-intervention unit 7a;
 * contract §5.5, §12.7, §12.9, §4.9). Pure: defaults, semantic validation and
 * comparison. The opening-hours week is validated by the pickup domain
 * (`normalizeOpeningHours`, reused unchanged): seven days, `HH:mm`, open before
 * close, no overlaps, no midnight crossing, IANA zone.
 *
 * `scheduling` and `enabledSubtypes` are STORED ONLY in this unit: nothing
 * reads them yet (scheduled conversations are unit 14).
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  DEFAULT_BUSINESS_TIME_ZONE,
  normalizeOpeningHours,
  WEEKDAYS,
  type OpeningHours,
  type OpeningRange,
} from '../../shipping/pickup/domain/opening-hours';
import { isCalendarDate } from '../../chatbot-requests/domain/business-hours-calendar';
import {
  collectFieldErrors,
  DEFAULT_START_TIMEOUT_SECONDS,
  DEFAULT_TEMPLATE_LANGUAGE_CODE,
  MAX_CLOSED_DATES,
  MAX_REASON_LENGTH,
  MAX_SLA_MINUTES,
  SettingsValidationError,
  START_TIMEOUT_MAX_SECONDS,
  START_TIMEOUT_MIN_SECONDS,
  TEMPLATE_LANGUAGE_CODE,
  type FieldError,
} from './chatbot-settings-validation';

export {
  DEFAULT_START_TIMEOUT_SECONDS,
  DEFAULT_TEMPLATE_LANGUAGE_CODE,
  MAX_CLOSED_DATES,
  MAX_SLA_MINUTES,
  START_TIMEOUT_MAX_SECONDS,
  START_TIMEOUT_MIN_SECONDS,
};

export const ALL_SUBTYPES = [
  'RESTOCK',
  'EXPIRATION',
  'DELIVERY_ZONE',
  'TRANSFER_RECEIPT',
  'TALK_TO_HUMAN',
  'COMPLAINT',
  'UNKNOWN_QUESTION',
  'DISCOUNT',
] as const;
export type SettingsSubtype = (typeof ALL_SUBTYPES)[number];

export interface SlaEntry {
  subtype: SettingsSubtype;
  claimMinutes: number | null;
  resolveMinutes: number | null;
}

export interface SchedulingSettings {
  enabled: boolean;
  slotMinutes: number;
  slotsOffered: number;
  maxScheduledPerSlot: number;
}

export interface AttentionSettings {
  openingHours: OpeningHours;
  closedDates: string[];
  /** S11: why a date is closed; keys are a subset of `closedDates`, sorted. */
  closedDateReasons: Record<string, string>;
  slas: SlaEntry[];
  windowWarningMinutes: number;
  templateName: string | null;
  templateCostText: string;
  enabledSubtypes: SettingsSubtype[];
  receiptCloseMarginMinutes: number;
  /** S16 1a: seconds a claim waits for `session-ack STARTED` (30..600). */
  startTimeoutSeconds: number;
  /** S16 8: language code `template.requested` carries (`es_MX`). */
  templateLanguageCode: string;
  scheduling: SchedulingSettings;
}

/** What `normalizeSettingsInput` accepts: the validated body of a PUT. */
export interface AttentionSettingsInput {
  openingHours: {
    timeZone?: string | null;
    days: Array<{ day: string; ranges: OpeningRange[] }>;
  };
  closedDates: string[];
  /** Optional; absent means no reasons (a PUT replaces the whole object). */
  closedDateReasons?: Record<string, string>;
  slas: SlaEntry[];
  windowWarningMinutes: number;
  templateName: string | null;
  templateCostText: string;
  enabledSubtypes: SettingsSubtype[];
  receiptCloseMarginMinutes: number;
  /** Optional (additive, S16): absent keeps the stored value, else the default. */
  startTimeoutSeconds?: number | null;
  templateLanguageCode?: string | null;
  scheduling: SchedulingSettings;
}

export const DEFAULT_TEMPLATE_COST_TEXT =
  'Enviar la plantilla tiene un costo para el negocio.';

/** Design §4 "Tiempos límite" (initial, configurable). */
const DEFAULT_SLAS: Record<SettingsSubtype, [number | null, number | null]> = {
  RESTOCK: [60, 240],
  EXPIRATION: [60, 240],
  DELIVERY_ZONE: [60, 240],
  TRANSFER_RECEIPT: [null, null],
  TALK_TO_HUMAN: [10, null],
  COMPLAINT: [30, 240],
  UNKNOWN_QUESTION: [30, 120],
  DISCOUNT: [30, 120],
};

/** The value of a tenant that never saved settings (version 0). */
export function defaultSettings(): AttentionSettings {
  const openDays = new Set(WEEKDAYS.slice(0, 6));
  return {
    openingHours: {
      timeZone: DEFAULT_BUSINESS_TIME_ZONE,
      days: WEEKDAYS.map((day) => ({
        day,
        ranges: openDays.has(day) ? [{ open: '09:00', close: '19:00' }] : [],
      })),
    },
    closedDates: [],
    closedDateReasons: {},
    slas: ALL_SUBTYPES.map((subtype) => ({
      subtype,
      claimMinutes: DEFAULT_SLAS[subtype][0],
      resolveMinutes: DEFAULT_SLAS[subtype][1],
    })),
    windowWarningMinutes: 120,
    templateName: null,
    templateCostText: DEFAULT_TEMPLATE_COST_TEXT,
    enabledSubtypes: [...ALL_SUBTYPES],
    receiptCloseMarginMinutes: 60,
    startTimeoutSeconds: DEFAULT_START_TIMEOUT_SECONDS,
    templateLanguageCode: DEFAULT_TEMPLATE_LANGUAGE_CODE,
    scheduling: {
      enabled: false,
      slotMinutes: 30,
      slotsOffered: 3,
      maxScheduledPerSlot: 3,
    },
  };
}

const invalid = (message: string): InvalidArgumentError =>
  new InvalidArgumentError(message, 'INVALID_CHATBOT_SETTINGS');

function integerIn(
  value: unknown,
  min: number,
  max: number,
  name: string,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw invalid(`${name} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function minutesOrNull(value: unknown, name: string): number | null {
  return value === null || value === undefined
    ? null
    : integerIn(value, 1, MAX_SLA_MINUTES, name);
}

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function isSubtype(value: unknown): value is SettingsSubtype {
  return (ALL_SUBTYPES as readonly unknown[]).includes(value);
}

function normalizeSlas(input: SlaEntry[]): SlaEntry[] {
  const seen = new Map<SettingsSubtype, SlaEntry>();
  for (const entry of input) {
    if (!isSubtype(entry.subtype)) throw invalid('Unknown subtype in slas');
    if (seen.has(entry.subtype)) {
      throw invalid(`slas lists ${entry.subtype} more than once`);
    }
    const claim = minutesOrNull(
      entry.claimMinutes,
      `${entry.subtype}.claimMinutes`,
    );
    const resolve = minutesOrNull(
      entry.resolveMinutes,
      `${entry.subtype}.resolveMinutes`,
    );
    if (entry.subtype === 'TRANSFER_RECEIPT' && resolve !== null) {
      throw invalid(
        'TRANSFER_RECEIPT.resolveMinutes must be null: the receipt rule sets it',
      );
    }
    if (claim !== null && resolve !== null && resolve < claim) {
      throw invalid(
        `${entry.subtype}: resolveMinutes cannot be below claimMinutes`,
      );
    }
    seen.set(entry.subtype, {
      subtype: entry.subtype,
      claimMinutes: claim,
      resolveMinutes: resolve,
    });
  }
  const missing = ALL_SUBTYPES.filter((s) => !seen.has(s));
  if (missing.length > 0) {
    throw invalid(
      `slas must list every subtype; missing ${missing.join(', ')}`,
    );
  }
  return ALL_SUBTYPES.map((s) => seen.get(s)!);
}

/**
 * Validates and canonicalizes a PUT body (400 `INVALID_CHATBOT_SETTINGS` or
 * the pickup domain's `INVALID_OPENING_HOURS`). The result is what is stored,
 * returned and compared. A rejection is a `SettingsValidationError`: the same
 * `code`/`message` as always (the first rule that fails) plus `fieldErrors`,
 * every located problem of the body (S11).
 */
export function normalizeSettingsInput(
  input: AttentionSettingsInput,
): AttentionSettings {
  const located = collectFieldErrors(input);
  let normalized: AttentionSettings;
  try {
    normalized = normalizeCore(input);
  } catch (error) {
    if (!(error instanceof InvalidArgumentError)) throw error;
    // The domain rejected it; the list says where (a fallback keeps it never empty).
    throw new SettingsValidationError(
      error.message,
      error.code,
      located.length > 0 ? located : [unlocated(error)],
    );
  }
  if (located.length > 0) {
    throw new SettingsValidationError(
      'closedDateReasons is invalid',
      'INVALID_CHATBOT_SETTINGS',
      located,
    );
  }
  return normalized;
}

/** A domain rejection the collector did not locate (it should not happen). */
const unlocated = (error: InvalidArgumentError): FieldError => ({
  path: error.code === 'INVALID_OPENING_HOURS' ? 'openingHours' : '',
  code: 'INVALID_VALUE',
});

function normalizeReasons(
  input: AttentionSettingsInput,
  closedDates: string[],
): Record<string, string> {
  const raw = input.closedDateReasons;
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid('closedDateReasons must be an object keyed by date');
  }
  const entries: Array<[string, string]> = [];
  for (const date of Object.keys(raw).sort()) {
    const reason = raw[date];
    if (!isCalendarDate(date) || !closedDates.includes(date)) {
      throw invalid('closedDateReasons keys must be closed dates');
    }
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (
      trimmed.length < 1 ||
      Array.from(trimmed).length > MAX_REASON_LENGTH ||
      CONTROL.test(trimmed)
    ) {
      throw invalid(
        `a closed date reason must be plain text of 1 to ${MAX_REASON_LENGTH} characters`,
      );
    }
    entries.push([date, trimmed]);
  }
  // `fromEntries` defines own properties: no prototype write whatever the key.
  return Object.fromEntries(entries);
}

function normalizeCore(input: AttentionSettingsInput): AttentionSettings {
  const openingHours = normalizeOpeningHours(input.openingHours);
  if (!openingHours.days.some((day) => day.ranges.length > 0)) {
    throw invalid('openingHours needs at least one open range');
  }

  if (input.closedDates.length > MAX_CLOSED_DATES * 2) {
    throw invalid(`closedDates allows at most ${MAX_CLOSED_DATES} dates`);
  }
  for (const date of input.closedDates) {
    if (typeof date !== 'string' || !isCalendarDate(date)) {
      throw invalid('closedDates must be real dates written YYYY-MM-DD');
    }
  }
  const closedDates = [...new Set(input.closedDates)].sort();
  if (closedDates.length > MAX_CLOSED_DATES) {
    throw invalid(`closedDates allows at most ${MAX_CLOSED_DATES} dates`);
  }

  const templateCostText =
    typeof input.templateCostText === 'string'
      ? input.templateCostText.trim()
      : '';
  if (
    templateCostText.length < 1 ||
    templateCostText.length > 200 ||
    CONTROL.test(templateCostText)
  ) {
    throw invalid('templateCostText must be plain text of 1 to 200 characters');
  }

  const templateName = input.templateName;
  if (
    templateName !== null &&
    (typeof templateName !== 'string' || !TEMPLATE_NAME.test(templateName))
  ) {
    throw invalid(
      'templateName must be 1-512 lowercase letters, digits or underscores, or null',
    );
  }

  const templateLanguageCode =
    input.templateLanguageCode ?? DEFAULT_TEMPLATE_LANGUAGE_CODE;
  if (
    typeof templateLanguageCode !== 'string' ||
    !TEMPLATE_LANGUAGE_CODE.test(templateLanguageCode)
  ) {
    throw invalid('templateLanguageCode must look like es_MX');
  }

  const enabled: SettingsSubtype[] = [];
  for (const subtype of input.enabledSubtypes) {
    if (!isSubtype(subtype))
      throw invalid('Unknown subtype in enabledSubtypes');
    if (!enabled.includes(subtype)) enabled.push(subtype);
  }

  const scheduling = input.scheduling;
  return {
    openingHours,
    closedDates,
    closedDateReasons: normalizeReasons(input, closedDates),
    slas: normalizeSlas(input.slas),
    windowWarningMinutes: integerIn(
      input.windowWarningMinutes,
      0,
      1440,
      'windowWarningMinutes',
    ),
    templateName,
    templateCostText,
    enabledSubtypes: enabled,
    receiptCloseMarginMinutes: integerIn(
      input.receiptCloseMarginMinutes,
      0,
      1440,
      'receiptCloseMarginMinutes',
    ),
    startTimeoutSeconds: integerIn(
      input.startTimeoutSeconds ?? DEFAULT_START_TIMEOUT_SECONDS,
      START_TIMEOUT_MIN_SECONDS,
      START_TIMEOUT_MAX_SECONDS,
      'startTimeoutSeconds',
    ),
    templateLanguageCode,
    scheduling: {
      enabled: scheduling.enabled === true,
      slotMinutes: integerIn(
        scheduling.slotMinutes,
        5,
        240,
        'scheduling.slotMinutes',
      ),
      slotsOffered: integerIn(
        scheduling.slotsOffered,
        1,
        10,
        'scheduling.slotsOffered',
      ),
      maxScheduledPerSlot: integerIn(
        scheduling.maxScheduledPerSlot,
        1,
        50,
        'scheduling.maxScheduledPerSlot',
      ),
    },
  };
}

/** Content equality of two normalized settings (no write when equal). */
export function settingsEqual(
  a: AttentionSettings,
  b: AttentionSettings,
): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(s: AttentionSettings) {
  return {
    ...s,
    enabledSubtypes: [...s.enabledSubtypes].sort(),
  };
}
