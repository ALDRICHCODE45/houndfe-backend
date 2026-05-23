import { ParsedDateRange } from '../listing-types';
import { assertNotInvertedRange } from './range-guarantees';

type ParseDateRangeInput = {
  field: string;
  fromField: string;
  toField: string;
  from?: string | Date;
  to?: string | Date;
};

const parseDateValue = (
  value: string | Date | undefined,
  field: string,
): Date | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`LISTING_INVALID_DATE: field=${field}`);
  }

  return date;
};

export function parseDateRange(input: ParseDateRangeInput): ParsedDateRange {
  const from = parseDateValue(input.from, input.fromField);
  const to = parseDateValue(input.to, input.toField);

  assertNotInvertedRange(from, to, 'LISTING_INVERTED_RANGE', input.field);

  return {
    from,
    to,
  };
}
