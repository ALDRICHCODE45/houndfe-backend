/**
 * shipping-zones / T7 (S10) — opening hours store DTOs. Shape checks live
 * here (400 from `ValidationPipe`); the week rules (seven days, open < close,
 * no overlaps, IANA zone) are `normalizeOpeningHours` (400
 * INVALID_OPENING_HOURS).
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  WEEKDAYS,
  type OpeningDay,
  type Weekday,
} from '../domain/opening-hours';

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class OpeningRangeDto {
  @IsString()
  @Matches(HH_MM)
  open!: string;

  @IsString()
  @Matches(HH_MM)
  close!: string;
}

export class OpeningDayDto {
  @IsIn(WEEKDAYS)
  day!: Weekday;

  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => OpeningRangeDto)
  ranges!: OpeningRangeDto[];
}

export class PutOpeningHoursDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timeZone?: string;

  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => OpeningDayDto)
  days!: OpeningDayDto[];
}

export interface OpeningHoursResponse {
  configured: boolean;
  openingHours: {
    timeZone: string;
    days: OpeningDay[];
    updatedAt: string;
  } | null;
}
