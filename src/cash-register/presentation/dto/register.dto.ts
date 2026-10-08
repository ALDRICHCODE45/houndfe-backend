/**
 * DTOs: cash-register administration (T3/S1,S3).
 *
 * `name` is normalized (trimmed) and bounded; `isActive` is the only
 * lifecycle toggle the register PATCH route accepts. The tenant boundary and
 * the actor come exclusively from the verified JWT + `PermissionsGuard`
 * ability, never from this body — `forbidNonWhitelisted` rejects any extra
 * key such as `tenantId` or `id`.
 */
import { IsBoolean, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import {
  CASH_NAME_MAX_LENGTH,
  IsCashOptional,
  TrimString,
} from './cash-dto.shared';

export class CreateRegisterDto {
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CASH_NAME_MAX_LENGTH)
  name!: string;
}

export class UpdateRegisterDto {
  @IsCashOptional()
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CASH_NAME_MAX_LENGTH)
  name?: string;

  @IsCashOptional()
  @IsBoolean()
  isActive?: boolean;
}
