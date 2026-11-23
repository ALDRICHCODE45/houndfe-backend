import { IsUUID, ValidateIf } from 'class-validator';

/**
 * customer-pets / T3 (contract §4.2) — `PUT /sales/drafts/:id/items/:itemId/pet`.
 * `petId` is required: a uuid assigns the pet to the line, `null` clears it.
 */
export class SetItemPetDto {
  @ValidateIf((_, value: unknown) => value !== null)
  @IsUUID()
  petId!: string | null;
}
