import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** Sender phone is supplied by the trusted chatbot adapter, never by the model. */
export class CheckoutContextQueryDto {
  @IsString()
  @Matches(/^[0-9]{1,10}$/)
  phoneCountryCode!: string;

  @IsString()
  @Matches(/^[0-9]{1,20}$/)
  phone!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit: number = 10;

  @IsOptional()
  @IsUUID()
  afterAddressId?: string;
}
