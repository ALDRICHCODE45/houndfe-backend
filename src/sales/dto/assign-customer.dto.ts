import { IsOptional, IsUUID, ValidateIf } from 'class-validator';

export class AssignCustomerDto {
  @IsUUID()
  customerId!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  shippingAddressId?: string | null;
}
