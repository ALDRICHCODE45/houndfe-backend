import { IsString, IsNumber, IsOptional, IsUUID, Min } from 'class-validator';

export class AddItemDto {
  @IsString()
  productId: string;

  @IsOptional()
  @IsString()
  variantId?: string | null;

  @IsNumber()
  @Min(1)
  quantity: number;

  /**
   * customer-pets / T3 (contract §4.2) — the pet this line is for. Absent: the
   * line keeps whatever pet it has; a uuid assigns it (new or stacked line);
   * `null` clears it.
   */
  @IsOptional()
  @IsUUID()
  petId?: string | null;
}
