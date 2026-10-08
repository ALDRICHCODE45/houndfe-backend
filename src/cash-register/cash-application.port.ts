import type { AppAbility } from '../auth/authorization/domain/permission';
import type {
  CashCountLine,
  CashDenominationLine,
  CashHandoverKind,
} from './domain/cash-register.types';

export const CASH_APPLICATION = Symbol('CASH_APPLICATION');

export interface CashActor {
  userId: string;
  ability: AppAbility;
}

export type CashJson =
  | null
  | boolean
  | number
  | string
  | CashJson[]
  | { [key: string]: CashJson };
export type CashDocument = { [key: string]: CashJson };

export interface CashCountInput {
  lines: CashCountLine[];
  denominations?: CashDenominationLine[];
  notes?: string;
}

export type CashCommand =
  | { kind: 'CREATE_REGISTER'; name: string }
  | { kind: 'UPDATE_REGISTER'; id: string; name?: string; isActive?: boolean }
  | {
      kind: 'OPEN_SESSION';
      registerId: string;
      openingCents: number;
      openingHandoverId?: string;
      openingConfirmed: boolean;
    }
  | {
      kind: 'CASH_IN' | 'CASH_OUT';
      sessionId: string;
      amountCents: number;
      reason: string;
    }
  | { kind: 'START_COUNT'; sessionId: string }
  | ({ kind: 'DECLARE' | 'VERIFY'; sessionId: string } & CashCountInput)
  | { kind: 'ANNOTATE_DECLARATION'; sessionId: string; notes: string }
  | {
      kind: 'CREATE_HANDOVER';
      sessionId: string;
      handoverKind: CashHandoverKind;
      recipientUserId: string;
      declaredCents: number;
      notes?: string;
    }
  | {
      kind: 'RECEIVE_HANDOVER';
      id: string;
      receivedCents: number;
      notes?: string;
    }
  | { kind: 'RELEASE_DRAWER'; sessionId: string }
  | { kind: 'CLOSE'; sessionId: string; notes?: string };

export interface CashPageInput {
  page?: number;
  limit?: number;
  registerId?: string;
  cashierUserId?: string;
  from?: string;
  to?: string;
}

export type CashQuery =
  | { kind: 'REGISTERS' }
  | { kind: 'SESSION'; id: string }
  | { kind: 'SESSIONS'; page: CashPageInput; pendingOnly?: boolean }
  | { kind: 'CLOSINGS'; page: CashPageInput }
  | { kind: 'CLOSING'; id: string };

/** HTTP adapters supply authenticated actors; the service rechecks instance scope. */
export interface ICashApplication {
  execute(
    actor: CashActor,
    command: CashCommand,
    idempotencyKey: string,
  ): Promise<CashDocument>;
  query(actor: CashActor, query: CashQuery): Promise<CashDocument>;
}
