import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  ALL_SUBTYPES,
  defaultSettings,
  normalizeSettingsInput,
  settingsEqual,
  type AttentionSettingsInput,
} from './chatbot-attention-settings';

const valid = (): AttentionSettingsInput => {
  const d = defaultSettings();
  return JSON.parse(JSON.stringify(d)) as AttentionSettingsInput;
};

describe('defaultSettings (contract §5.5, design §4)', () => {
  it('is Monday-Saturday 09:00-19:00 in America/Mexico_City', () => {
    const { openingHours } = defaultSettings();
    expect(openingHours.timeZone).toBe('America/Mexico_City');
    const open = openingHours.days
      .filter((d) => d.ranges.length > 0)
      .map((d) => d.day);
    expect(open).toEqual([
      'MONDAY',
      'TUESDAY',
      'WEDNESDAY',
      'THURSDAY',
      'FRIDAY',
      'SATURDAY',
    ]);
    for (const day of openingHours.days.filter((d) => d.ranges.length > 0)) {
      expect(day.ranges).toEqual([{ open: '09:00', close: '19:00' }]);
    }
    expect(openingHours.days).toHaveLength(7);
  });

  it('carries the SLA table of the design', () => {
    const table = Object.fromEntries(
      defaultSettings().slas.map((s) => [
        s.subtype,
        [s.claimMinutes, s.resolveMinutes],
      ]),
    );
    expect(table).toEqual({
      RESTOCK: [60, 240],
      EXPIRATION: [60, 240],
      DELIVERY_ZONE: [60, 240],
      TRANSFER_RECEIPT: [null, null],
      TALK_TO_HUMAN: [10, null],
      COMPLAINT: [30, 240],
      UNKNOWN_QUESTION: [30, 120],
      DISCOUNT: [30, 120],
    });
  });

  it('has the remaining initial values of the contract', () => {
    const d = defaultSettings();
    expect(d.receiptCloseMarginMinutes).toBe(60);
    expect(d.closedDates).toEqual([]);
    expect(d.templateName).toBeNull();
    expect(d.templateCostText).toBe(
      'Enviar la plantilla tiene un costo para el negocio.',
    );
    expect(d.scheduling).toEqual({
      enabled: false,
      slotMinutes: 30,
      slotsOffered: 3,
      maxScheduledPerSlot: 3,
    });
    expect([...d.enabledSubtypes].sort()).toEqual([...ALL_SUBTYPES].sort());
  });

  it('returns a fresh object each time', () => {
    const a = defaultSettings();
    a.closedDates.push('2026-12-25');
    expect(defaultSettings().closedDates).toEqual([]);
  });
});

describe('normalizeSettingsInput', () => {
  it('accepts the defaults unchanged', () => {
    const input = valid();
    expect(
      settingsEqual(normalizeSettingsInput(input), defaultSettings()),
    ).toBe(true);
  });

  it('sorts and de-duplicates closed dates', () => {
    const input = valid();
    input.closedDates = ['2026-12-25', '2026-01-01', '2026-12-25'];
    expect(normalizeSettingsInput(input).closedDates).toEqual([
      '2026-01-01',
      '2026-12-25',
    ]);
  });

  it.each(['2026-02-30', '2026-1-1', 'tomorrow', '2026-13-01', ''])(
    'rejects closed date %p',
    (date) => {
      const input = valid();
      input.closedDates = [date];
      expect(() => normalizeSettingsInput(input)).toThrow(InvalidArgumentError);
    },
  );

  it('rejects more than 400 closed dates', () => {
    const input = valid();
    const start = Date.UTC(2026, 0, 1);
    input.closedDates = Array.from({ length: 401 }, (_, i) =>
      new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    );
    expect(() => normalizeSettingsInput(input)).toThrow(InvalidArgumentError);
  });

  it('reuses the pickup opening-hours rules (overlap, midnight, zone)', () => {
    const overlap = valid();
    overlap.openingHours.days[0].ranges = [
      { open: '09:00', close: '14:00' },
      { open: '13:00', close: '18:00' },
    ];
    expect(() => normalizeSettingsInput(overlap)).toThrow(InvalidArgumentError);

    const midnight = valid();
    midnight.openingHours.days[0].ranges = [{ open: '22:00', close: '02:00' }];
    expect(() => normalizeSettingsInput(midnight)).toThrow(
      InvalidArgumentError,
    );

    const zone = valid();
    zone.openingHours.timeZone = 'Mars/Olympus';
    expect(() => normalizeSettingsInput(zone)).toThrow(InvalidArgumentError);
  });

  it('defaults a missing zone like the pickup hours do', () => {
    const input = valid();
    delete (input.openingHours as { timeZone?: string }).timeZone;
    expect(normalizeSettingsInput(input).openingHours.timeZone).toBe(
      'America/Mexico_City',
    );
  });

  it('rejects a week with no open range', () => {
    const input = valid();
    for (const day of input.openingHours.days) day.ranges = [];
    expect(() => normalizeSettingsInput(input)).toThrow(InvalidArgumentError);
  });

  it('requires one SLA entry per subtype, exactly once', () => {
    const missing = valid();
    missing.slas = missing.slas.slice(1);
    expect(() => normalizeSettingsInput(missing)).toThrow(InvalidArgumentError);

    const duplicate = valid();
    duplicate.slas = [...duplicate.slas.slice(1), duplicate.slas[1]];
    expect(() => normalizeSettingsInput(duplicate)).toThrow(
      InvalidArgumentError,
    );

    const unknown = valid();
    unknown.slas[0] = {
      subtype: 'NOPE' as never,
      claimMinutes: 1,
      resolveMinutes: 2,
    };
    expect(() => normalizeSettingsInput(unknown)).toThrow(InvalidArgumentError);
  });

  it('returns the SLA entries in the subtype order whatever the input order', () => {
    const input = valid();
    input.slas.reverse();
    expect(normalizeSettingsInput(input).slas.map((s) => s.subtype)).toEqual(
      defaultSettings().slas.map((s) => s.subtype),
    );
  });

  it.each([0, -5, 1.5, 10081])('rejects SLA minutes %p', (minutes) => {
    const input = valid();
    input.slas[0].claimMinutes = minutes;
    expect(() => normalizeSettingsInput(input)).toThrow(InvalidArgumentError);
  });

  it('accepts null SLA minutes and the 10080 maximum', () => {
    const input = valid();
    input.slas[0].claimMinutes = null;
    input.slas[0].resolveMinutes = 10080;
    expect(() => normalizeSettingsInput(input)).not.toThrow();
  });

  it('rejects a resolve time shorter than the claim time', () => {
    const input = valid();
    const restock = input.slas.find((s) => s.subtype === 'RESTOCK')!;
    restock.claimMinutes = 120;
    restock.resolveMinutes = 60;
    expect(() => normalizeSettingsInput(input)).toThrow(InvalidArgumentError);
  });

  it('keeps the receipt resolve time out of configuration (the §5.4 rule decides)', () => {
    const input = valid();
    input.slas.find((s) => s.subtype === 'TRANSFER_RECEIPT')!.resolveMinutes =
      60;
    expect(() => normalizeSettingsInput(input)).toThrow(InvalidArgumentError);
  });

  it.each([-1, 1441, 1.5])('rejects windowWarningMinutes %p', (v) => {
    const input = valid();
    input.windowWarningMinutes = v;
    expect(() => normalizeSettingsInput(input)).toThrow(InvalidArgumentError);
  });

  it.each([-1, 1441, 0.5])('rejects receiptCloseMarginMinutes %p', (v) => {
    const input = valid();
    input.receiptCloseMarginMinutes = v;
    expect(() => normalizeSettingsInput(input)).toThrow(InvalidArgumentError);
  });

  it('accepts margin 0', () => {
    const input = valid();
    input.receiptCloseMarginMinutes = 0;
    expect(normalizeSettingsInput(input).receiptCloseMarginMinutes).toBe(0);
  });

  it('validates the template name and cost text', () => {
    const ok = valid();
    ok.templateName = 'respuesta_equipo_v1';
    expect(normalizeSettingsInput(ok).templateName).toBe('respuesta_equipo_v1');

    for (const bad of ['Has Spaces', 'UPPER', '', 'a'.repeat(513)]) {
      const input = valid();
      input.templateName = bad;
      expect(() => normalizeSettingsInput(input)).toThrow(InvalidArgumentError);
    }

    const blank = valid();
    blank.templateCostText = '   ';
    expect(() => normalizeSettingsInput(blank)).toThrow(InvalidArgumentError);

    const long = valid();
    long.templateCostText = 'x'.repeat(201);
    expect(() => normalizeSettingsInput(long)).toThrow(InvalidArgumentError);

    const control = valid();
    control.templateCostText = 'a\u0000b';
    expect(() => normalizeSettingsInput(control)).toThrow(InvalidArgumentError);

    const trimmed = valid();
    trimmed.templateCostText = '  Cuesta $1  ';
    expect(normalizeSettingsInput(trimmed).templateCostText).toBe('Cuesta $1');
  });

  it('de-duplicates enabled subtypes and rejects unknown ones', () => {
    const input = valid();
    input.enabledSubtypes = ['RESTOCK', 'RESTOCK', 'COMPLAINT'];
    expect(normalizeSettingsInput(input).enabledSubtypes).toEqual([
      'RESTOCK',
      'COMPLAINT',
    ]);
    input.enabledSubtypes = ['NOPE' as never];
    expect(() => normalizeSettingsInput(input)).toThrow(InvalidArgumentError);
  });

  it.each([
    ['slotMinutes', 4],
    ['slotMinutes', 241],
    ['slotsOffered', 0],
    ['slotsOffered', 11],
    ['maxScheduledPerSlot', 0],
    ['maxScheduledPerSlot', 51],
  ] as const)('rejects scheduling.%s = %p', (field, value) => {
    const input = valid();
    input.scheduling[field] = value;
    expect(() => normalizeSettingsInput(input)).toThrow(InvalidArgumentError);
  });
});

describe('settingsEqual', () => {
  it('is true for equal content and false for any change', () => {
    const a = defaultSettings();
    const b = defaultSettings();
    expect(settingsEqual(a, b)).toBe(true);
    b.scheduling.slotsOffered = 4;
    expect(settingsEqual(a, b)).toBe(false);
    const c = defaultSettings();
    c.closedDates = ['2026-12-25'];
    expect(settingsEqual(a, c)).toBe(false);
  });
});
