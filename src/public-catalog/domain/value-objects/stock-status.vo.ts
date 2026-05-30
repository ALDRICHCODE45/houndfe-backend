export type PublicStockStatus = 'available' | 'low_stock' | 'out_of_stock';

export function mapStockStatus(
  quantity: number,
  minQuantity: number,
): PublicStockStatus {
  if (quantity <= 0) return 'out_of_stock';
  if (quantity <= minQuantity) return 'low_stock';
  return 'available';
}

export function mapStockStatusLabel(status: PublicStockStatus): string {
  const labels: Record<PublicStockStatus, string> = {
    available: 'Disponible',
    low_stock: 'Pocas piezas',
    out_of_stock: 'Agotado',
  };
  return labels[status];
}
