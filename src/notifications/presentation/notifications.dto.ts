/**
 * Query and body of the notifications routes. The global ValidationPipe
 * rejects unknown fields, so no tenant or user can arrive from the client.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { MAX_PAGE_SIZE } from '../application/notifications.service';

export class ListNotificationsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unread?: boolean;
}

/** At least one flag; the service keeps the other as stored. */
export class NotificationPreferencesDto {
  // ValidateIf instead of IsOptional: an absent flag is fine, but null must
  // fail here (400) rather than reach a non-null Prisma column.
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  emailEnabled?: boolean;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  soundEnabled?: boolean;
}
