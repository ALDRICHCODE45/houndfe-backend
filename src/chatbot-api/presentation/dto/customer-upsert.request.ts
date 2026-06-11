import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MEXICAN_STATES } from '../../../customers/domain/constants';
import { IsIn } from 'class-validator';

export class CustomerPhoneLookupQueryDto {
  @IsString()
  @MaxLength(10)
  phoneCountryCode!: string;

  @IsString()
  @MaxLength(20)
  phone!: string;
}

export class CustomerDeliveryAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsString()
  @MaxLength(200)
  street!: string;

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

  @IsOptional()
  @IsString()
  @MaxLength(500)
  visualReferences?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  carrierPhone?: string;
}

export class CustomerUpsertRequestDto {
  @IsString()
  @MaxLength(100)
  firstName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsString()
  @MaxLength(10)
  phoneCountryCode!: string;

  @IsString()
  @MaxLength(20)
  phone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  preferredPaymentMethod?: string;

  @ValidateNested()
  @Type(() => CustomerDeliveryAddressDto)
  address!: CustomerDeliveryAddressDto;
}
