import { IsString, IsNumber, IsOptional, Min, IsEnum } from 'class-validator';

export class CreateProductDto {
  @IsString()
  name: string;

  @IsNumber()
  @Min(0)
  price: number;

  @IsEnum(['USD', 'EUR', 'ARS', 'MXN'])
  currency: 'USD' | 'EUR' | 'ARS' | 'MXN';

  @IsString()
  sku: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  stock?: number;
}
