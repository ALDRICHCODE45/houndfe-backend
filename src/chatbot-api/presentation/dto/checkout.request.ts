import { Type } from 'class-transformer';
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
  BotSaleShippingDto,
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
  @IsIn(['existing', 'newSaved'])
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
export class CheckoutSaleDto {
  @IsUUID()
  cashierUserId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BotSaleItemDto)
  items!: BotSaleItemDto[];

  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  expectedTotalCents!: number;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => BotSaleShippingDto)
  shipping?: BotSaleShippingDto;
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

  @IsObject()
  @ValidateNested()
  @Type(() => AddressIntent, {
    discriminator: {
      property: 'mode',
      subTypes: [
        { name: 'existing', value: ExistingCheckoutAddressDto },
        { name: 'newSaved', value: NewCheckoutAddressDto },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  deliveryAddress!: ExistingCheckoutAddressDto | NewCheckoutAddressDto;

  @IsObject()
  @ValidateNested()
  @Type(() => CheckoutSaleDto)
  sale!: CheckoutSaleDto;
}
