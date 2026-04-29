export interface AvailablePriceEntryDto {
  priceListId: string;
  priceListName: string;
  priceCents: number;
  currency: 'MXN';
  isCurrent: boolean;
}

export interface AvailablePricesResponseDto {
  saleId: string;
  itemId: string;
  prices: AvailablePriceEntryDto[];
}
