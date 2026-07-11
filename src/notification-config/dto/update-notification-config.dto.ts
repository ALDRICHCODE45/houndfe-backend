/**
 * PUT /notification-config body DTO.
 *
 * `enabledActions` is typed as plain `string[]` here — the SERVICE layer
 * narrows to `NotificationActionKey[]` and throws `UNKNOWN_ACTION_KEY`
 * (HTTP 400) on unknown keys. This keeps the DTO decoupled from the v1
 * enum so adding a new key is a domain-only change.
 *
 * Mirrors `src/products/dto/variant-price.dto.ts` for the array pattern.
 */
import { IsArray, IsBoolean, IsDefined, IsString } from 'class-validator';

export class UpdateNotificationConfigDto {
  @IsDefined()
  @IsBoolean()
  enabled!: boolean;

  @IsDefined()
  @IsArray()
  @IsString({ each: true })
  recipientUserIds!: string[];

  @IsDefined()
  @IsArray()
  @IsString({ each: true })
  enabledActions!: string[];
}
