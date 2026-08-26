import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

type CollectionPaymentMethod =
  | 'cash'
  | 'card_credit'
  | 'card_debit'
  | 'transfer';

@ValidatorConstraint({ name: 'collectionPaymentShape', async: false })
class CollectionPaymentShapeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args?: ValidationArguments): boolean {
    const dto = args?.object as AddSalePaymentDto | undefined;
    if (!dto) return false;

    const hasLegacy = dto.method !== undefined || dto.amountCents !== undefined;
    const hasArray = dto.payments !== undefined;

    if (hasLegacy && hasArray) {
      return false;
    }

    if (hasArray) {
      return (dto.payments?.length ?? 0) > 0;
    }

    return dto.method !== undefined && dto.amountCents !== undefined;
  }
}

export class AddSalePaymentEntryDto {
  @IsIn(['cash', 'card_credit', 'card_debit', 'transfer'])
  method: CollectionPaymentMethod;

  @IsInt()
  @Min(1)
  amountCents: number;

  @IsOptional()
  @IsString()
  reference?: string;

  // Custom Payment Methods (custom-payment-methods / WU2) — optional
  // catalog reference. Mirrors `ChargePaymentEntryDto.paymentMethodId`;
  // resolution semantics are identical (the sales service looks the
  // row up via `IPaymentMethodResolver.resolveActive()` and snapshots
  // it under `metadataJson.catalog`).
  @IsOptional()
  @IsUUID('all', { message: 'INVALID_PAYMENT_METHOD_ID' })
  paymentMethodId?: string;
}

export class AddSalePaymentDto {
  @Validate(CollectionPaymentShapeConstraint)
  private readonly shapeAndReferenceValidation = true;

  @IsOptional()
  @IsIn(['cash', 'card_credit', 'card_debit', 'transfer'])
  method?: CollectionPaymentMethod;

  @IsOptional()
  @IsInt()
  @Min(1)
  amountCents?: number;

  @IsOptional()
  @IsString()
  reference?: string;

  // Optional single-payment catalog reference — mirrors the per-entry
  // `paymentMethodId` on the `payments[]` branch.
  @IsOptional()
  @IsUUID('all', { message: 'INVALID_PAYMENT_METHOD_ID' })
  paymentMethodId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => AddSalePaymentEntryDto)
  payments?: AddSalePaymentEntryDto[];
}