import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

type CollectionPaymentMethod = 'cash' | 'card_credit' | 'card_debit' | 'transfer';

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

@ValidatorConstraint({ name: 'collectionReferenceRequirement', async: false })
class CollectionReferenceRequirementConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown, args?: ValidationArguments): boolean {
    const dto = args?.object as AddSalePaymentDto | undefined;
    if (!dto?.payments?.length) {
      return true;
    }

    return dto.payments.every((payment) => {
      if (payment.method === 'cash') {
        return true;
      }

      return Boolean(payment.reference?.trim().length);
    });
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
}

export class AddSalePaymentDto {
  @Validate(CollectionPaymentShapeConstraint)
  @Validate(CollectionReferenceRequirementConstraint)
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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => AddSalePaymentEntryDto)
  payments?: AddSalePaymentEntryDto[];
}
