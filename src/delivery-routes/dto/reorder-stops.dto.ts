/**
 * DTO: ReorderStopsDto — delivery-routes / WU2.
 *
 * Body of `PUT /delivery-routes/:id/stops/reorder`. The payload carries
 * the desired stop order as an array of stop ids; the aggregate
 * validates that every existing stop appears exactly once.
 */
import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class ReorderStopsDto {
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMinSize(1, {
    message: 'orderedStopIds must contain at least one stop id',
  })
  orderedStopIds!: string[];
}
