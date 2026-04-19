import {
  IsString,
  IsOptional,
  IsEmail,
  IsArray,
  IsIn,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MEXICAN_STATES } from '../domain/constants';
import { FISCAL_REGIMES } from '../domain/constants';
import { CreateAddressDto } from './address.dto';

export class CreateCustomerDto {
  // ── Basic info ──

  @IsString()
  @MaxLength(100)
  firstName: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  phoneCountryCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  globalPriceListId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comments?: string;

  // ── Billing data (all optional) ──

  @IsOptional()
  @IsString()
  @MaxLength(200)
  businessName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  fiscalZipCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(13)
  rfc?: string;

  @IsOptional()
  @IsIn([...FISCAL_REGIMES])
  fiscalRegime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  billingStreet?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  billingExteriorNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  billingInteriorNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  billingZipCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  billingNeighborhood?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  billingMunicipality?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  billingCity?: string;

  @IsOptional()
  @IsIn([...MEXICAN_STATES])
  billingState?: string;

  // ── Inline addresses (optional, atomic creation) ──

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateAddressDto)
  addresses?: CreateAddressDto[];
}
