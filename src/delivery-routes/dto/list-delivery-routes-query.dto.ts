/**
 * DTO: ListDeliveryRoutesQueryDto — delivery-routes / WU2.
 *
 * Query string for `GET /delivery-routes`. All fields optional. The
 * service applies the driver-only filter via `request.ability` (design
 * ADR-5) so this DTO does NOT expose a `driverUserId` field — drivers
 * always get `driverUserId = self`, admins/super-admins get the unfiltered
 * tenant list.
 */
import { IsEnum, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export type DeliveryRouteListStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED';

export class ListDeliveryRoutesQueryDto {
  @IsOptional()
  @Type(() => String)
  @IsEnum(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'], {
    each: false,
  })
  status?: DeliveryRouteListStatus;
}
