import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Contract §5 — the selector fields. Addresses (any address of a customer)
 * for the four location fields, the customer's `fiscalRegime` for the last
 * (only the SAT codes in use). There is no `preferredPaymentMethod` option
 * (§4.5) and no zone option: `deliveryZoneType` is a fixed enum.
 */
export enum CustomersListingOptionField {
  neighborhood = 'neighborhood',
  municipality = 'municipality',
  city = 'city',
  zipCode = 'zipCode',
  fiscalRegime = 'fiscalRegime',
}

/** customers-listing — query of `GET /customers/listing/options` (§5). */
export class CustomersListingOptionsQueryDto {
  @IsEnum(CustomersListingOptionField)
  field!: CustomersListingOptionField;

  /** Optional case-insensitive `contains`. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}
