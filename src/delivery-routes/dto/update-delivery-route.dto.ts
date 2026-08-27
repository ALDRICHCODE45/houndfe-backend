/**
 * DTO: UpdateDeliveryRouteDto — delivery-routes / WU2.
 *
 * Body of `PATCH /delivery-routes/:id`. DRAFT-only mutators:
 *   - `driverUserId` — reassign the driver (mid-route reassignment is
 *     rejected at the aggregate level).
 *   - `notes` — set or clear (max 280 chars).
 * All fields optional; the service short-circuits empty bodies.
 */
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class UpdateDeliveryRouteDto {
  @IsOptional()
  @IsUUID('4')
  driverUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  notes?: string | null;
}
