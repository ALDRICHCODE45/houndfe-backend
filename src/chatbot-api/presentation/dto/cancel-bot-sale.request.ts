import { IsEnum, IsUUID } from 'class-validator';
import type { SaleCancelReason } from '../../../sales/domain/sale.entity';

export class CancelBotSaleRequestDto {
  @IsEnum(['CUSTOMER_REQUEST', 'ORDER_ERROR', 'OUT_OF_STOCK', 'DUPLICATE_SALE', 'OTHER'])
  reason: SaleCancelReason;

  @IsUUID()
  cashierUserId: string;
}
