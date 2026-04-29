import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class ApplyItemDiscountDto {
  @IsIn(['amount', 'percentage'])
  type!: 'amount' | 'percentage';

  @ValidateIf((o) => o.type === 'amount')
  @IsInt()
  @Min(1)
  @IsOptional()
  amountCents?: number;

  @ValidateIf((o) => o.type === 'percentage')
  @IsInt()
  @Min(1)
  @Max(99)
  @IsOptional()
  percent?: number;

  @IsOptional()
  @IsString()
  discountTitle?: string;

  @IsOptional()
  @IsString()
  title?: string;
}
