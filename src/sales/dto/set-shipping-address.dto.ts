import { IsUUID, ValidateIf } from 'class-validator';

export class SetShippingAddressDto {
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  shippingAddressId!: string | null;
}
