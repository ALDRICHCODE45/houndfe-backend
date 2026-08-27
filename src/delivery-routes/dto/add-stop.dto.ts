/**
 * DTO: AddStopDto — delivery-routes / WU2.
 *
 * Body of `POST /delivery-routes/:id/stops`. Appends a single eligible
 * sale to a DRAFT route. Sale eligibility is re-checked server-side.
 */
import { IsUUID } from 'class-validator';

export class AddStopDto {
  @IsUUID('4')
  saleId!: string;
}
