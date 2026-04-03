import { IsString, MaxLength } from 'class-validator';

export class CreatePriceListDto {
  @IsString()
  @MaxLength(50)
  name: string;
}
