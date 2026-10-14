/**
 * DTOs: cash custody handovers (T3/S2,S5).
 *
 * A handover declares custody out of the drawer (`WITHDRAWAL`) or retained
 * opening float (`FLOAT`). The recipient is a user UUID supplied by the
 * sender; the receiving actor is derived from the verified JWT on the receive
 * route, never from this body — the application re-checks that the authenticated
 * actor matches the bound recipient.
 *
 * Declared/received amounts are integer cents. `declaredCents` must be
 * positive (a zero-declared custody transfer is not meaningful); a receiver
 * may confirm `receivedCents = 0` when the physical handover was empty, which
 * is the justified zero case.
 */
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { CashHandoverKind } from '../../domain/cash-register.types';
import {
  CASH_CENTS_MAX,
  CASH_NOTES_MAX_LENGTH,
  IsCashOptional,
  TrimString,
} from './cash-dto.shared';

/** Closed handover-kind vocabulary mirrored from the domain. */
export const CASH_HANDOVER_KIND_VALUES = ['WITHDRAWAL', 'FLOAT'] as const;

export class CreateHandoverDto {
  @IsIn(CASH_HANDOVER_KIND_VALUES)
  handoverKind!: CashHandoverKind;

  @IsUUID()
  recipientUserId!: string;

  @IsInt()
  @Min(1)
  @Max(CASH_CENTS_MAX)
  declaredCents!: number;

  @IsCashOptional()
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CASH_NOTES_MAX_LENGTH)
  notes?: string;
}

export class ReceiveHandoverDto {
  /** Physical amount actually received; `0` is the justified empty case. */
  @IsInt()
  @Min(0)
  @Max(CASH_CENTS_MAX)
  receivedCents!: number;

  @IsCashOptional()
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CASH_NOTES_MAX_LENGTH)
  notes?: string;
}
