import { IsNumber, Min } from 'class-validator';

export class UpdateItemQuantityDto {
  @IsNumber()
  @Min(1)
  quantity: number;
}
