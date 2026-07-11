import {
  IsEnum,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TimeOffType } from '@prisma/client';

export class CreateTimeOffDto {
  @IsEnum(TimeOffType)
  type: TimeOffType;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
