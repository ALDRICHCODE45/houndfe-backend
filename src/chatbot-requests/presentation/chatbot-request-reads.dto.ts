/**
 * Query strings of the staff read routes (§3.8, §12.3). The global
 * ValidationPipe rejects unknown parameters, so `q` (free-text search) is a 400
 * until it ships.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  AssigneeFilter,
  InboxTab,
} from '../application/chatbot-request-reads.service';
import { MAX_PAGE } from '../application/chatbot-request-reads.service';
import type { ChatbotRequestSubtype } from '../domain/chatbot-request.commands';

const TABS: readonly InboxTab[] = [
  'open',
  'resolved',
  'cancelled',
  'scheduled',
];
const SUBTYPES: readonly ChatbotRequestSubtype[] = [
  'RESTOCK',
  'EXPIRATION',
  'DELIVERY_ZONE',
  'TRANSFER_RECEIPT',
  'TALK_TO_HUMAN',
  'COMPLAINT',
  'UNKNOWN_QUESTION',
  'DISCOUNT',
];
/** `me`, `unassigned` (`none` is an alias) or a user id. */
const ASSIGNEE = /^(me|unassigned|none|[0-9a-fA-F-]{36})$/;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export function parseAssignee(raw?: string): AssigneeFilter | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'me') return { kind: 'me' };
  if (raw === 'unassigned' || raw === 'none') return { kind: 'unassigned' };
  return { kind: 'user', id: raw };
}

class PageDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  limit?: number;
}

export class GroupsQueryDto extends PageDto {
  @IsOptional()
  @IsIn(TABS)
  status?: InboxTab;

  @IsOptional()
  @IsIn(SUBTYPES)
  subtype?: ChatbotRequestSubtype;

  @IsOptional()
  @Matches(ASSIGNEE)
  assignee?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  overdue?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  windowClosingSoon?: boolean;
}

export class CustomerListQueryDto extends PageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  customerKey!: string;

  @IsOptional()
  @IsIn(TABS)
  status?: InboxTab;
}

export class HistoryQueryDto extends PageDto {
  @IsOptional()
  @IsIn(SUBTYPES)
  subtype?: ChatbotRequestSubtype;

  @IsOptional()
  @IsUUID()
  resolvedBy?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  customerKey?: string;
}

export class AuditQueryDto extends PageDto {}
