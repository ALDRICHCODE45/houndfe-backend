import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  PET_BIRTH_DATE_PRECISIONS,
  PET_LIMITS,
  PET_LIST_STATUSES,
  PET_SIZES,
  PET_SPECIES,
  type PetBirthDatePrecision,
  type PetListStatus,
  type PetSize,
  type PetSpecies,
} from '../../domain/customer-pet.types';

/**
 * Wire shapes of the pet routes (contract §3, §5), validated by the global
 * `ValidationPipe` (whitelist + forbidNonWhitelisted) so a bad field answers the
 * same per-field `400` as the customer DTOs. Cross-field rules (precision with
 * date, `approxAge` vs `birthDate`, `speciesOther`, future dates) live in the
 * domain (`customer-pet-rules.ts`), shared with the bot.
 */

/** Trims strings before validation so lengths count the stored text. */
const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class ApproxAgeDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PET_LIMITS.approxAgeYearsMax)
  years?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PET_LIMITS.approxAgeMonthsMax)
  months?: number;
}

/** Fields that are optional (and `null` = absent/clear) on create and PATCH. */
export class PetOptionalFieldsDto {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(PET_LIMITS.speciesOtherMax)
  speciesOther?: string | null;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(PET_LIMITS.breedMax)
  breed?: string | null;

  @IsOptional()
  @IsIn(PET_SIZES)
  size?: PetSize | null;

  /** `YYYY-MM-DD`; the domain checks the calendar and the future. */
  @IsOptional()
  @IsString()
  birthDate?: string | null;

  @IsOptional()
  @IsIn(PET_BIRTH_DATE_PRECISIONS)
  birthDatePrecision?: PetBirthDatePrecision | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => ApproxAgeDto)
  approxAge?: ApproxAgeDto | null;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(PET_LIMITS.allergiesMax)
  allergies?: string | null;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(PET_LIMITS.notesMax)
  notes?: string | null;
}

export class CreateCustomerPetDto extends PetOptionalFieldsDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PET_LIMITS.nameMax)
  name: string;

  @IsIn(PET_SPECIES)
  species: PetSpecies;
}

/** PATCH: absent = unchanged; `null` clears a nullable field, `null` name/species → 400. */
export class UpdateCustomerPetDto extends PetOptionalFieldsDto {
  @IsInt()
  @Min(1)
  version: number;

  @ValidateIf((_o, value) => value !== undefined)
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PET_LIMITS.nameMax)
  name?: string | null;

  @ValidateIf((_o, value) => value !== undefined)
  @IsIn(PET_SPECIES)
  species?: PetSpecies | null;
}

export class ArchiveCustomerPetDto {
  @IsInt()
  @Min(1)
  version: number;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(PET_LIMITS.archivedReasonMax)
  reason?: string | null;
}

export class RestoreCustomerPetDto {
  @IsInt()
  @Min(1)
  version: number;
}

/** `DELETE …?version=N`: never a body (contract §6). */
export class DeleteCustomerPetQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;
}

export class ListCustomerPetsQueryDto {
  @IsOptional()
  @IsIn(PET_LIST_STATUSES)
  status?: PetListStatus;
}
