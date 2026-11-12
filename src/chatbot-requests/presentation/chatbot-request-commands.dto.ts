/**
 * Bodies and the `Idempotency-Key` header of the staff command routes
 * (§3.8, §12.11, §12.12, §12.14). The global ValidationPipe rejects unknown
 * fields, so no tenant, actor or assignee can arrive in a body.
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsDefined,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  isUUID,
} from 'class-validator';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import type { StaffCancelReason } from '../domain/chatbot-request.commands';

/** `Idempotency-Key: <uuid>`; missing or malformed is 400 VALIDATION_ERROR. */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const raw = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>().headers[
      'idempotency-key'
    ];
    if (typeof raw !== 'string' || !isUUID(raw.trim())) {
      throw new InvalidArgumentError(
        'Idempotency-Key must be a UUID',
        'VALIDATION_ERROR',
      );
    }
    return raw.trim().toLowerCase();
  },
);

export class ExpectedVersionDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class ReassignDto extends ExpectedVersionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  toUserId!: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string;
}

const STAFF_CANCEL_REASONS: readonly StaffCancelReason[] = [
  'DUPLICATE',
  'NOT_ACTIONABLE',
  'CUSTOMER_UNREACHABLE',
  'OTHER',
];

export class CancelDto extends ExpectedVersionDto {
  @IsIn(STAFF_CANCEL_REASONS)
  reason!: StaffCancelReason;

  /** Internal; required (1..500) with `OTHER`, checked by the state machine. */
  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string;

  /** What the bot relays to the customer (§12.14). */
  @IsOptional()
  @IsString()
  @Length(1, 500)
  customerNote?: string;
}

/**
 * Unit 10 (§3.8 `reply {text ≤ 1500}`). `text` is `unknown` here on purpose:
 * `parseReplyText` (domain) owns the rules (sanitising, trim, 1..1500
 * characters), so the DTO only requires that the key is present.
 */
export class ReplyDto extends ExpectedVersionDto {
  @IsDefined()
  text!: unknown;
}

/** §12.11: the target is the request that stays; both versions are checked. */
export class MergeDto extends ExpectedVersionDto {
  @IsUUID()
  intoRequestId!: string;

  @IsInt()
  @Min(1)
  intoExpectedVersion!: number;
}

/** R1 (§3.8): one of the candidates the detail lists. */
export class LinkCustomerDto extends ExpectedVersionDto {
  @IsUUID()
  customerId!: string;
}

/**
 * Unit 11 (§4.8 `finish {expectedVersion, note ≤ 1000, complaintOutcome?}`).
 * `note` is `unknown` on purpose: `parseFinishNote` (domain) owns the rules.
 * `complaintOutcome` is only recorded in this unit (unit 12 enforces it).
 */
export class FinishDto extends ExpectedVersionDto {
  @IsDefined()
  note!: unknown;

  @IsOptional()
  @IsIn(['RETURN', 'REPLACEMENT', 'REFUND', 'NO_ACTION'])
  complaintOutcome?: string;
}

/**
 * Unit 11 (§4.4 `messages {clientMessageId, expectedEpoch, text}`). The header
 * `Idempotency-Key` must equal `clientMessageId`. `text` is `unknown`:
 * `parseStaffMessageText` owns the rules.
 */
export class StaffMessageDto {
  @IsUUID()
  clientMessageId!: string;

  @IsInt()
  @Min(1)
  expectedEpoch!: number;

  @IsDefined()
  text!: unknown;
}
