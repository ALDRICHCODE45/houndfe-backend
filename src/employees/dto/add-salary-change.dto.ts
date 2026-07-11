import {
  IsInt,
  Min,
  IsOptional,
  IsString,
  Length,
  IsDateString,
  MinLength,
} from 'class-validator';

export class AddSalaryChangeDto {
  @IsInt()
  @Min(1)
  amountCents: number;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsDateString()
  effectiveFrom: string;

  @IsString()
  @MinLength(1)
  reason: string;
}
