import { buildDisplayName } from './employee-display-name';

describe('buildDisplayName', () => {
  it('joins first and last name with a single space', () => {
    expect(buildDisplayName('Ana', 'Gómez')).toBe('Ana Gómez');
  });

  it('returns only the first name when the last name is missing', () => {
    expect(buildDisplayName('Ana', null)).toBe('Ana');
    expect(buildDisplayName('Ana', undefined)).toBe('Ana');
  });

  it('returns only the last name when the first name is missing', () => {
    expect(buildDisplayName(null, 'Gómez')).toBe('Gómez');
    expect(buildDisplayName(undefined, 'Gómez')).toBe('Gómez');
  });

  it('falls back to "(empleado)" when both names are missing', () => {
    expect(buildDisplayName(null, null)).toBe('(empleado)');
    expect(buildDisplayName(undefined, undefined)).toBe('(empleado)');
    expect(buildDisplayName('', '')).toBe('(empleado)');
  });

  it('falls back to "(empleado)" when the names are whitespace-only', () => {
    expect(buildDisplayName('   ', '   ')).toBe('(empleado)');
  });

  it('trims surrounding whitespace from the composed name', () => {
    expect(buildDisplayName('  ', 'Gómez')).toBe('Gómez');
    expect(buildDisplayName('Ana', '   ')).toBe('Ana');
  });
});
