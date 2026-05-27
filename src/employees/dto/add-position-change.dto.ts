import { IsString, MinLength, IsOptional, IsDateString } from 'class-validator';

export class AddPositionChangeDto {
  @IsString()
  @MinLength(1)
  position: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsDateString()
  effectiveFrom: string;

  @IsString()
  @MinLength(1)
  reason: string;
}
