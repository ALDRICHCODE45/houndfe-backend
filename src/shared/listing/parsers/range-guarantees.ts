export function assertNotInvertedRange(
  min: number | Date | undefined,
  max: number | Date | undefined,
  code: string,
  field: string,
): void {
  if (min === undefined || max === undefined) {
    return;
  }

  if (min > max) {
    throw new Error(`${code}: field=${field}`);
  }
}
