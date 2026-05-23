import { parseDateRange } from './date-range.parser';

describe('parseDateRange', () => {
  it('parses a valid from/to range', () => {
    const result = parseDateRange({
      field: 'confirmedAt',
      fromField: 'confirmedFrom',
      toField: 'confirmedTo',
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-30T23:59:59Z',
    });

    expect(result.from?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(result.to?.toISOString()).toBe('2026-06-30T23:59:59.000Z');
  });

  it('normalizes non-UTC offsets to UTC dates', () => {
    const result = parseDateRange({
      field: 'confirmedAt',
      fromField: 'confirmedFrom',
      toField: 'confirmedTo',
      from: '2026-06-01T00:00:00-05:00',
    });

    expect(result.from?.toISOString()).toBe('2026-06-01T05:00:00.000Z');
  });

  it('throws LISTING_INVALID_DATE for malformed date', () => {
    expect(() =>
      parseDateRange({
        field: 'confirmedAt',
        fromField: 'confirmedFrom',
        toField: 'confirmedTo',
        from: 'not-a-date',
      }),
    ).toThrow('LISTING_INVALID_DATE');
  });

  it('throws LISTING_INVERTED_RANGE when from is greater than to', () => {
    expect(() =>
      parseDateRange({
        field: 'confirmedAt',
        fromField: 'confirmedFrom',
        toField: 'confirmedTo',
        from: '2026-07-01T00:00:00Z',
        to: '2026-06-01T00:00:00Z',
      }),
    ).toThrow('LISTING_INVERTED_RANGE');
  });
});
