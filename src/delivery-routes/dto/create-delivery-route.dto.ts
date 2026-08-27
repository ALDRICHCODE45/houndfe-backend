/**
 * DTO: CreateDeliveryRouteDto — delivery-routes / WU2.
 *
 * Body of `POST /delivery-routes`. Validated by the global
 * `ValidationPipe` so every field MUST pass `class-validator` before
 * the service sees the payload.
 *
 * Per spec *Create DeliveryRoute in DRAFT*: `saleIds` MUST be ≥ 1,
 * every id a uuid; `driverUserId` a uuid; `notes` optional and trimmed.
 * The aggregate re-validates sale eligibility server-side; the DTO is
 * shape-only.
 */
import {
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateDeliveryRouteDto {
  @IsArray()
  @IsUUID('4', { each: true })
  @MinLength(1, { message: 'saleIds must contain at least one sale id' })
  saleIds!: string[];

  @IsUUID('4')
  driverUserId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  notes?: string;
}
