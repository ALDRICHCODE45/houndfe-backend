import {
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
  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsDateString()
  manufactureDate?: string;

  @IsOptional()
  @IsDateString()
  expirationDate?: string;
}
