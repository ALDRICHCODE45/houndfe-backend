/**
 * Bodies of the chatbot settings routes (contract §5.5). The global
 * ValidationPipe rejects unknown fields; `branchOpeningHours` is the one
 * read-only field the PUT accepts and ignores (§12.9), so the frontend can send
 * back what it got. Week rules are the pickup domain's (`normalizeOpeningHours`,
 * run by `normalizeSettingsInput`); these checks are shapes only.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PutOpeningHoursDto } from '../../shipping/pickup/dto/opening-hours.dto';
import {
  ALL_SUBTYPES,
  type SettingsSubtype,
} from '../domain/chatbot-attention-settings';

export class SlaEntryDto {
  @IsIn(ALL_SUBTYPES)
  subtype!: SettingsSubtype;

  @ValidateIf((_, value) => value !== null)
  @IsInt()
  claimMinutes!: number | null;

  @ValidateIf((_, value) => value !== null)
  @IsInt()
  resolveMinutes!: number | null;
}

export class SchedulingDto {
  @IsBoolean()
  enabled!: boolean;

  @IsInt()
  slotMinutes!: number;

  @IsInt()
  slotsOffered!: number;

  @IsInt()
  maxScheduledPerSlot!: number;
}

export class PutChatbotSettingsDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ValidateNested()
  @Type(() => PutOpeningHoursDto)
  openingHours!: PutOpeningHoursDto;

  @IsArray()
  @ArrayMaxSize(800)
  @IsString({ each: true })
  closedDates!: string[];

  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => SlaEntryDto)
  slas!: SlaEntryDto[];

  @IsInt()
  windowWarningMinutes!: number;

  @ValidateIf((_, value) => value !== null)
  @IsString()
  templateName!: string | null;

  @IsString()
  templateCostText!: string;

  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(ALL_SUBTYPES, { each: true })
  enabledSubtypes!: SettingsSubtype[];

  @IsInt()
  receiptCloseMarginMinutes!: number;

  @ValidateNested()
  @Type(() => SchedulingDto)
  scheduling!: SchedulingDto;

  /** Read-only (§12.9): accepted and ignored. */
  @IsOptional()
  @IsObject()
  branchOpeningHours?: unknown;
}

export class ApplyToAllDto {
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  /** Optional CAS on the source (this tenant's) settings version. */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
