import {
  Allow,
  IsString,
  IsOptional,
  IsIn,
  MaxLength,
  Validate,
  ValidateIf,
  ValidatorConstraint,
} from 'class-validator';
import type {
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { MEXICAN_STATES } from '../domain/constants';

@ValidatorConstraint({ name: 'addressCoordinatePair', async: false })
class AddressCoordinatePair implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const address = args.object as AddressCoordinatesDto;
    const { latitude, longitude } = address;
    if (latitude === undefined && longitude === undefined) return true;
    if (latitude === null && longitude === null) return true;
    return (
      typeof latitude === 'number' &&
      Number.isFinite(latitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      typeof longitude === 'number' &&
      Number.isFinite(longitude) &&
      longitude >= -180 &&
      longitude <= 180
    );
  }

  defaultMessage(): string {
    return 'latitude and longitude must both be null or finite numbers within geographic bounds';
  }
}

class AddressCoordinatesDto {
  // Validate the pair even when latitude is missing; IsOptional would skip null.
  @Validate(AddressCoordinatePair)
  latitude?: number | null;

  @Allow()
  longitude?: number | null;
}

export class CreateAddressDto extends AddressCoordinatesDto {
  @IsString()
  @MaxLength(200)
  street: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  exteriorNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  interiorNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  zipCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  neighborhood?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  municipality?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsIn([...MEXICAN_STATES])
  state?: string;
}

export class UpdateAddressDto extends AddressCoordinatesDto {
  @ValidateIf((_address, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(200)
  street?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  exteriorNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  interiorNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  zipCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  neighborhood?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  municipality?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @IsOptional()
  @IsIn([...MEXICAN_STATES])
  state?: string | null;
}
