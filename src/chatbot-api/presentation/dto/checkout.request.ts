import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CustomerDeliveryAddressDto } from './customer-upsert.request';
import {
  BotSaleItemDto,
  botSaleShippingType,
  type BotSaleShipping,
} from './register-bot-sale.request';

class CustomerIntent {
  @IsIn(['existing', 'createIfAbsent'])
  mode!: string;
}
export class ExistingCheckoutCustomerDto extends CustomerIntent {
  @IsUUID()
  customerId!: string;
}
export class NewCheckoutCustomerDto extends CustomerIntent {
  @IsString()
  @Matches(/\S/)
  @MaxLength(100)
  firstName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string | null;
}
class AddressIntent {
  @IsIn(['existing', 'newSaved', 'existingUpdated'])
  mode!: string;
}
export class ExistingCheckoutAddressDto extends AddressIntent {
  @IsUUID()
  addressId!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  expectedVersion!: string;
}
class NewAddressFields extends CustomerDeliveryAddressDto {
  @Matches(/\S/)
  declare street: string;
}
export class NewCheckoutAddressDto extends AddressIntent {
  @IsObject()
  @ValidateNested()
  @Type(() => NewAddressFields)
  address!: NewAddressFields;
}
export class ExistingUpdatedCheckoutAddressDto extends ExistingCheckoutAddressDto {
  @IsObject()
  @ValidateNested()
  @Type(() => NewAddressFields)
  address!: NewAddressFields;
}
/**
 * A checkout line. `backorderId` (restock-backorder / T3, contract v1 §7) is
 * optional and exists ONLY here: the legacy `POST /chatbot-api/sales` keeps the
 * plain `BotSaleItemDto` (it has no seam to validate and consume a reservation,
 * and `forbidNonWhitelisted` rejects the member there). `null` means omitted,
 * like `variantId`.
 */
export class CheckoutSaleItemDto extends BotSaleItemDto {
  @IsOptional()
  @IsUUID()
  backorderId?: string | null;

  /**
   * customer-pets / T3 (contract §4.2) — the pet this line is for: an ACTIVE pet
   * of the checkout customer (404 PET_NOT_FOUND / 422 PET_CUSTOMER_MISMATCH /
   * 422 PET_ARCHIVED otherwise). Optional like `backorderId` and, like it, part
   * of the request hash only when present; `null` means omitted. A UUID is
   * lower-cased on the way in (ids are stored lower-case), so one pet is one
   * value for the lookup and the hash.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID()
  petId?: string | null;
}

export class CheckoutSaleDto {
  @IsUUID()
  cashierUserId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CheckoutSaleItemDto)
  items!: CheckoutSaleItemDto[];

  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  expectedTotalCents!: number;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(botSaleShippingType)
  shipping?: BotSaleShipping;
}
export class CheckoutRequestDto {
  @IsString()
  @Matches(/^[0-9]{1,10}$/)
  phoneCountryCode!: string;

  @IsString()
  @Matches(/^[0-9]{1,20}$/)
  phone!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => CustomerIntent, {
    discriminator: {
      property: 'mode',
      subTypes: [
        { name: 'existing', value: ExistingCheckoutCustomerDto },
        { name: 'createIfAbsent', value: NewCheckoutCustomerDto },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  customer!: ExistingCheckoutCustomerDto | NewCheckoutCustomerDto;

  // Optional only with `sale.shipping: { mode: "pickup" }`; the controller
  // rejects a missing address for any other shipping (400).
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => AddressIntent, {
    discriminator: {
      property: 'mode',
      subTypes: [
        { name: 'existing', value: ExistingCheckoutAddressDto },
        { name: 'newSaved', value: NewCheckoutAddressDto },
        { name: 'existingUpdated', value: ExistingUpdatedCheckoutAddressDto },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  deliveryAddress?:
    | ExistingCheckoutAddressDto
    | NewCheckoutAddressDto
    | ExistingUpdatedCheckoutAddressDto;

  @IsObject()
  @ValidateNested()
  @Type(() => CheckoutSaleDto)
  sale!: CheckoutSaleDto;
}
