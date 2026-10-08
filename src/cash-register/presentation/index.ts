/**
 * PUBLIC PRESENTATION API: cash-register (T3).
 *
 * Re-exports the controllers and transport DTOs so the parent can wire a
 * `CashRegisterModule` without reaching into individual files. No module is
 * declared here: module wiring is a parent decision (app.module.ts /
 * CashRegisterModule are explicitly out of T3's edit surface).
 */
export { CashRegisterController } from './cash-register.controller';
export { CashSessionController } from './cash-session.controller';
export { CashHandoverController } from './cash-handover.controller';
export { CashClosingController } from './cash-closing.controller';

export { requireCashActor, type CashRequestWithAbility } from './cash-actor';
export { toCashPageInput } from './cash-query.mapper';

export {
  IdempotencyKey,
  IDEMPOTENCY_KEY_HEADER,
} from './decorators/idempotency-key.decorator';
export {
  ParseIdempotencyKeyPipe,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  INVALID_IDEMPOTENCY_KEY_CODE,
  type ArgumentMetadataShim,
} from './pipes/parse-idempotency-key.pipe';

export { CreateRegisterDto, UpdateRegisterDto } from './dto/register.dto';
export {
  OpenSessionDto,
  CashCountLineDto,
  CashDenominationLineDto,
  CashCountDto,
  AnnotateDeclarationDto,
  CashMovementDto,
  CloseSessionDto,
} from './dto/session.dto';
export {
  CreateHandoverDto,
  ReceiveHandoverDto,
  CASH_HANDOVER_KIND_VALUES,
} from './dto/handover.dto';
export {
  CashListQueryDto,
  ListSessionsQueryDto,
  ListClosingsQueryDto,
} from './dto/query.dto';
export {
  CASH_CENTS_MAX,
  CASH_NAME_MAX_LENGTH,
  CASH_REASON_MAX_LENGTH,
  CASH_NOTES_MAX_LENGTH,
  CASH_CHANNEL_KEY_MAX_LENGTH,
  CASH_COUNT_LINES_MAX,
  CASH_DENOMINATIONS_MAX,
  CASH_LIST_DEFAULT_PAGE,
  CASH_LIST_DEFAULT_LIMIT,
  CASH_LIST_MAX_LIMIT,
  CASH_LIST_MAX_PAGE,
} from './dto/cash-dto.shared';
