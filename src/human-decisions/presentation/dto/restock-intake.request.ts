/**
 * DTO: RestockIntakeRequestDto — HD-03a bot RESTOCK intake body.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 *
 * This class is the HTTP boundary for the future guarded `POST` intake
 * route (HD-03b owns the controller/guard). It is pipe-only: it never reads
 * authority from the body. `tenantId`, `source`, branch fields, the
 * submitting credential and every customer/PII field are intentionally
 * ABSENT, so the global `ValidationPipe({ whitelist: true,
 * forbidNonWhitelisted: true, transform: true })` (`main.ts`) refuses any
 * extra key instead of silently stripping it. Tenant and credential come
 * from `ServiceAuthGuard`; `source` and `type` are fixed server-side.
 *
 * EXACT bot body (peer-confirmed): `sourceRequestId`, `type`, `productId`,
 * `productName`, `variantId`, `sku`, `requestedQuantity`,
 * `observedStockAtRequest`, `stockObservedAt`, `supersedesDecisionId`. The
 * bot emits nullable fields explicitly as `null`; the backend ALSO accepts
 * them omitted — `@IsOptional()` skips `null`/`undefined` and HD-02a
 * normalizes both to `null` for the canonical hash/replay identity.
 *
 * Layering (defense in depth, no duplication):
 *   - This DTO performs STRUCTURAL validation only: required fields, fixed
 *     `type` discriminant, RFC 4122-shaped UUIDs, string types and the
 *     integer/safeness bounds. It deliberately does NOT cap `productName`
 *     length (HD-02a trims/collapses and then bounds it at 200 UTF-16 units)
 *     and does NOT cap `sku` (the schema column is unbounded `TEXT`).
 *   - HD-02a (`normalizeRestockRequest`) owns SEMANTIC validation: NFC
 *     normalization, control-character rejection, whitespace collapsing,
 *     canonical (non-nil) UUIDs, the strict calendar-valid ISO-8601
 *     `Z`/`±hh:mm` timestamp and the `observedStockAtRequest`/
 *     `stockObservedAt` "both present or both absent" PAIR rule. The pair is
 *     intentionally delegated to HD-02a, not enforced here, because it is a
 *     request-identity rule rather than a field type.
 *
 * Any value that fails here, or fails HD-02a downstream, is a sanitized
 * `400 VALIDATION_ERROR` through `HumanDecisionHttpFilter`; no raw value is
 * echoed back.
 */
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { RESTOCK_TYPE } from '../../domain/restock-request-canonicalizer';

/**
 * `class-validator`'s `@IsInt()` only proves `Number.isInteger`; pairing it
 * with `@Min`/`@Max` enforces the JS safe-integer range so an unsafe value is
 * never silently accepted at the boundary. HD-02a re-checks
 * `Number.isSafeInteger` as the second line of defense.
 */
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export class RestockIntakeRequestDto {
  /**
   * Bot's stable UUID. HD-03b must also match it against the
   * `X-Idempotency-Key` header before intake.
   */
  @IsUUID()
  sourceRequestId!: string;

  /** Required fixed discriminant; the only supported decision type is RESTOCK. */
  @IsIn([RESTOCK_TYPE])
  type!: typeof RESTOCK_TYPE;

  /** Catalog product identity (RFC 4122 shape; HD-02a rejects nil/invalid). */
  @IsUUID()
  productId!: string;

  /** Sanitized later by HD-02a (NFC + collapse + 200-unit bound). */
  @IsString()
  @IsNotEmpty()
  productName!: string;

  /** Optional/omitted nullable variant identity. */
  @IsOptional()
  @IsUUID()
  variantId?: string | null;

  /** Optional/omitted nullable SKU. HD-02a rejects control characters. */
  @IsOptional()
  @IsString()
  sku?: string | null;

  /** Optional/omitted nullable requested units: positive safe integer. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SAFE_INTEGER)
  requestedQuantity?: number | null;

  /** Optional/omitted nullable observed stock: non-negative safe integer. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_SAFE_INTEGER)
  observedStockAtRequest?: number | null;

  /**
   * Optional/omitted nullable observation time. Type is checked here; the
   * strict calendar-valid ISO-8601 `Z`/`±hh:mm` form and UTC normalization
   * are enforced by HD-02a.
   */
  @IsOptional()
  @IsString()
  stockObservedAt?: string | null;

  /** Optional/omitted nullable predecessor decision UUID. */
  @IsOptional()
  @IsUUID()
  supersedesDecisionId?: string | null;
}
