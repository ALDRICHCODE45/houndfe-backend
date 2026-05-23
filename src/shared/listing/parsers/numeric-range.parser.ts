import { ParsedNumericRange } from '../listing-types';
import { assertNotInvertedRange } from './range-guarantees';

type ParseNumericRangeInput = {
  field: string;
  minField: string;
  maxField: string;
  min?: number;
  max?: number;
};

const assertFinite = (value: number | undefined, field: string) => {
  if (value === undefined) {
    return;
  }

  if (!Number.isFinite(value)) {
    throw new Error(`LISTING_INVALID_NUMBER: field=${field}`);
  }
};

export function parseNumericRange(input: ParseNumericRangeInput): ParsedNumericRange {
  assertFinite(input.min, input.minField);
  assertFinite(input.max, input.maxField);

  assertNotInvertedRange(
    input.min,
    input.max,
    'LISTING_INVERTED_RANGE',
    input.field,
  );

  return {
    min: input.min,
    max: input.max,
  };
}
