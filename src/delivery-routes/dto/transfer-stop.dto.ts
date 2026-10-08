/**
 * DTO: TransferStopDto — delivery-routes / S3.
 *
 * Body of `POST /delivery-routes/:routeId/stops/:stopId/transfer`.
 * Moves one stop from the origin route (path `:routeId`) to the DRAFT
 * destination route named here. Both routes must be DRAFT; the move is
 * explicit and never leaves the sale reserved by both routes.
 */
import { IsUUID } from 'class-validator';

export class TransferStopDto {
  /** The DRAFT route that receives the stop, appended at the end. */
  @IsUUID('4')
  destinationRouteId!: string;
}
