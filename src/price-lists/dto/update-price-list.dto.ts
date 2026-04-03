import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdatePriceListDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;
}
