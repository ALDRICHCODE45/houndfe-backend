import { Type } from 'class-transformer';
import {
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
import {
  ExistingCheckoutCustomerDto,
  NewCheckoutCustomerDto,
} from '../../../chatbot-api/presentation/dto/checkout.request';

const INT32_MAX = 2_147_483_647;

/**
 * Customer resolution (contract §2) is the one of checkout's `createIfAbsent`:
 * `{ mode: "existing", customerId }` or `{ mode: "createIfAbsent", firstName,
 * lastName? }` next to `phoneCountryCode`/`phone`. The two member shapes are
 * checkout's own DTOs; no address exists until checkout.
 */
export class CreateBackorderRequestDto {
  @IsString()
  @Matches(/^[0-9]{1,10}$/)
  phoneCountryCode!: string;

  @IsString()
  @Matches(/^[0-9]{1,20}$/)
  phone!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => Object, {
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

  @IsUUID()
  productId!: string;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsUUID()
  variantId?: string | null;

  @IsInt()
  @Min(1)
  @Max(INT32_MAX)
  quantity!: number;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(INT32_MAX)
  expectedReferencePriceCents?: number | null;

  @IsUUID()
  sourceDecisionId!: string;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsUUID()
  chatbotRequestId?: string | null;
}

export class CancelBackorderRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  reason?: string;
}
