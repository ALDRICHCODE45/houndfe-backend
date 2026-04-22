import { IsString, IsNumber, IsOptional, Min } from 'class-validator';

export class AddItemDto {
  @IsString()
  productId: string;

  @IsOptional()
  @IsString()
  variantId?: string | null;

  @IsNumber()
  @Min(1)
  quantity: number;
}
