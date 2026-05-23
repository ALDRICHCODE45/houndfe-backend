type ParseCsvMultiValueOptions = {
  field: string;
  cap: number;
};

const normalizeValues = (input: string): string[] =>
  input
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

export function parseCsvMultiValue(
  input: string | string[] | null | undefined,
  options: ParseCsvMultiValueOptions,
): string[] {
  const values = Array.isArray(input)
    ? input.flatMap((value) => normalizeValues(value))
    : normalizeValues(input ?? '');

  const deduped = Array.from(new Set(values));

  if (deduped.length > options.cap) {
    throw new Error(
      `LISTING_TOO_MANY_VALUES: field=${options.field} cap=${options.cap}`,
    );
  }

  return deduped;
}
