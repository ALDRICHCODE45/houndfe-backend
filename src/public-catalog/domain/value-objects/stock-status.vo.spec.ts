import {
  mapStockStatus,
  mapStockStatusLabel,
  type PublicStockStatus,
} from './stock-status.vo';

describe('mapStockStatus', () => {
  it('should return out_of_stock when quantity is 0', () => {
    expect(mapStockStatus(0, 5)).toBe('out_of_stock');
  });

  it('should return out_of_stock when quantity is negative', () => {
    expect(mapStockStatus(-1, 5)).toBe('out_of_stock');
  });

  it('should return low_stock when quantity equals minQuantity', () => {
    expect(mapStockStatus(5, 5)).toBe('low_stock');
  });

  it('should return low_stock when quantity is below minQuantity', () => {
    expect(mapStockStatus(2, 5)).toBe('low_stock');
  });

  it('should return available when quantity exceeds minQuantity', () => {
    expect(mapStockStatus(50, 5)).toBe('available');
  });

  it('should return available when minQuantity is 0 and quantity > 0', () => {
    expect(mapStockStatus(1, 0)).toBe('available');
  });
});

describe('mapStockStatusLabel', () => {
  it.each<[PublicStockStatus, string]>([
    ['available', 'Disponible'],
    ['low_stock', 'Pocas piezas'],
    ['out_of_stock', 'Agotado'],
  ])('should return "%s" label as "%s"', (status, label) => {
    expect(mapStockStatusLabel(status)).toBe(label);
  });
});
