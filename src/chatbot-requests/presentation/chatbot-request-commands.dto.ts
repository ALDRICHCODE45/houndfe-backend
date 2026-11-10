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
  IsOptional,
  IsString,
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
