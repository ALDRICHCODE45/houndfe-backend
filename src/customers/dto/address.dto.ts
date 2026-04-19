import { IsString, IsOptional, IsIn, MaxLength } from 'class-validator';
import { MEXICAN_STATES } from '../domain/constants';

export class CreateAddressDto {
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

export class UpdateAddressDto {
  @IsOptional()
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
