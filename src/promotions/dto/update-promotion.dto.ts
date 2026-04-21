import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreatePromotionDto } from './create-promotion.dto';

/**
 * UpdatePromotionDto — all fields optional except `type` which is omitted.
 * Type changes are forbidden at the service layer, not the DTO level.
 * We omit `type` from the PartialType to signal clearly that it cannot be changed.
 */
export class UpdatePromotionDto extends PartialType(
  OmitType(CreatePromotionDto, ['type'] as const),
) {}
