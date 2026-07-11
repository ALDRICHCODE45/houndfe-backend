import { IsEnum } from 'class-validator';
import type { SaleCancelReason } from '../domain/sale.entity';

export class CancelSaleDto {
  @IsEnum([
    'CUSTOMER_REQUEST',
    'ORDER_ERROR',
    'OUT_OF_STOCK',
    'DUPLICATE_SALE',
    'OTHER',
  ])
  reason: SaleCancelReason;
}
