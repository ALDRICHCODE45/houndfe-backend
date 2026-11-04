import {
  Allow,
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  Min,
} from 'class-validator';

export class CreateLotDto {
  @IsString()
  lotNumber: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsDateString()
  manufactureDate?: string;

  @IsDateString()
  expirationDate: string;
}

export class UpdateLotDto {
  /**
   * Not editable (O1/S2): declared without validation so the whitelist lets
   * the key through and the service answers 400 `STOCK_QUANTITY_READ_ONLY`.
   */
  @Allow()
  quantity?: unknown;

  @IsOptional()
  @IsDateString()
  manufactureDate?: string;

  @IsOptional()
  @IsDateString()
  expirationDate?: string;
}
