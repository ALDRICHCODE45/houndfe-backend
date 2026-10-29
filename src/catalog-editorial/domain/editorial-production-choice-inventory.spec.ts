import {
  ALIASES,
  INVENTORY,
  OVERLAY,
} from './editorial-production-choice-inventory';
import {
  CHOICES,
  type ChoiceCode,
} from './editorial-production-vocabulary-catalog';

it('exposes compact canonical rows referencing the existing choice codes', () => {
  expect(INVENTORY).toHaveLength(67);
  const codes: readonly ChoiceCode[] = INVENTORY.map(([code]) => code);
  expect(new Set(codes)).toEqual(new Set(CHOICES.map(([code]) => code)));
  expect(
    INVENTORY.reduce(
      (count, [, , , pairs]) => count + pairs.split('; ').length,
      0,
    ),
  ).toBe(514);
  expect(OVERLAY).toHaveLength(3);
  expect(ALIASES).toHaveLength(8);
});

it.each([
  ['inventory', INVENTORY, 4],
  ['overlay', OVERLAY, 2],
  ['aliases', ALIASES, 2],
] as const)(
  'freezes the %s outer array and every primitive tuple',
  (_name, rows, width) => {
    expect(Object.isFrozen(rows)).toBe(true);
    for (const row of rows) {
      expect(row).toHaveLength(width);
      expect(Object.isFrozen(row)).toBe(true);
      expect(row.every((value) => typeof value === 'string')).toBe(true);
    }
  },
);

it('does not grant consumers mutation authority at either level', () => {
  const before = JSON.stringify({ INVENTORY, OVERLAY, ALIASES });
  for (const rows of [INVENTORY, OVERLAY, ALIASES]) {
    expect(Reflect.set(rows, '0', [])).toBe(false);
    expect(Reflect.deleteProperty(rows, '0')).toBe(false);
    expect(Reflect.set(rows, 'length', 0)).toBe(false);
    for (const row of rows) {
      expect(Reflect.set(row, '0', 'caller mutation')).toBe(false);
      expect(Reflect.deleteProperty(row, '0')).toBe(false);
    }
  }
  expect(JSON.stringify({ INVENTORY, OVERLAY, ALIASES })).toBe(before);
});
