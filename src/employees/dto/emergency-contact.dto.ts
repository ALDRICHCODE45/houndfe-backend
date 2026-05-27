import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateEmergencyContactDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  relationship: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  phone: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;
}

export class UpdateEmergencyContactDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  relationship?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;
}
